use crate::db::connection::{get_conn_with_retry, DatabasePoolHandle};
use crate::db::postgres;
use crate::db::postgres_ddl::format_pg_error;
use crate::db::sql_script::split_sql_statements;
use crate::db::sql_utils::{esc_id, esc_str, pg_id, pg_str, strip_export_schema_qualifiers};
use crate::models::types::{
    ExportSqlFileResult, ImportSqlFileResult, ImportSqlStatementFailure, TableInfo,
};
use crate::AppState;
use mysql_async::prelude::*;
use mysql_async::Value as MyValue;
use std::collections::BTreeMap;
use std::io::BufWriter;
use std::io::ErrorKind;
use std::io::Write;
use std::path::Path;
use std::time::Instant;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::State;

/// 单文件导入上限。整文件会读入内存并拆句，过大可能导致内存占用高；可按需再调大。
const MAX_IMPORT_FILE_BYTES: u64 = 512 * 1024 * 1024;
const EXPORT_INSERT_BATCH: usize = 100;
const IMPORT_PROGRESS_EMIT_INTERVAL: usize = 25;
/// 失败详情最多记录条数，避免极大脚本时响应体过大
const MAX_RECORDED_IMPORT_FAILURES: usize = 80;
const MAX_IMPORT_FAILURE_STATEMENT_PREVIEW_CHARS: usize = 160;

fn format_fs_err(context: &str, e: std::io::Error) -> String {
    let hint = match e.kind() {
        ErrorKind::PermissionDenied => "（权限不足，请检查文件或目录是否可读写）",
        ErrorKind::NotFound => "（路径不存在或父目录缺失）",
        ErrorKind::AlreadyExists => "（目标已存在）",
        _ => "",
    };
    format!("{}{}: {}", context, hint, e)
}

#[derive(Clone, serde::Serialize)]
struct SqlImportProgress {
    current: u32,
    total: u32,
}

#[derive(Clone, serde::Serialize)]
struct SqlExportProgress {
    current: u32,
    total: u32,
}

fn strip_utf8_bom(bytes: &[u8]) -> &[u8] {
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        &bytes[3..]
    } else {
        bytes
    }
}

fn is_select_like(sql: &str) -> bool {
    let t = sql.trim();
    let upper = t.to_uppercase();
    upper.starts_with("SELECT")
        || upper.starts_with("SHOW")
        || upper.starts_with("DESCRIBE")
        || upper.starts_with("DESC ")
        || upper.starts_with("EXPLAIN")
        || upper.starts_with("WITH")
}

async fn run_one_statement(conn: &mut mysql_async::Conn, stmt: &str) -> Result<(), String> {
    if is_select_like(stmt) {
        let _: Vec<mysql_async::Row> = conn.query(stmt).await.map_err(|e| format!("{}", e))?;
    } else {
        conn.query_drop(stmt).await.map_err(|e| format!("{}", e))?;
    }
    Ok(())
}

async fn run_one_postgres_statement(
    client: &deadpool_postgres::Client,
    stmt: &str,
) -> Result<(), String> {
    client
        .simple_query(stmt)
        .await
        .map(|_| ())
        .map_err(|e| format_pg_error("导入 SQL", e))
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PgExportRelationKind {
    Table,
    View,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PgExportRelation {
    name: String,
    relation_kind: PgExportRelationKind,
    ddl: String,
    columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PgExportObject {
    name: String,
    ddl: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PgExportMetadata {
    schema: String,
    tables: Vec<PgExportRelation>,
    views: Vec<PgExportRelation>,
    indexes: Vec<PgExportObject>,
    foreign_keys: Vec<PgExportObject>,
    triggers: Vec<PgExportObject>,
    routines: Vec<PgExportObject>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PgExportInsertBatch {
    table: String,
    columns: Vec<String>,
    rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone)]
struct PgPrimaryKeyMeta {
    name: String,
    columns: Vec<String>,
}

#[derive(Debug, Clone)]
struct PgColumnMeta {
    name: String,
    data_type: String,
    not_null: bool,
    default_expr: Option<String>,
    identity: String,
    generated: String,
    generated_expr: Option<String>,
    comment: String,
}

fn ensure_semicolon(sql: &str) -> String {
    let trimmed = sql.trim();
    if trimmed.ends_with(';') {
        trimmed.to_string()
    } else {
        format!("{};", trimmed)
    }
}

fn starts_with_chars(chars: &[char], start: usize, expected: &str) -> bool {
    let expected_chars = expected.chars().collect::<Vec<_>>();
    if start + expected_chars.len() > chars.len() {
        return false;
    }
    chars[start..start + expected_chars.len()] == expected_chars[..]
}

fn is_pg_identifier_part(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

fn is_pg_bare_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_') && chars.all(is_pg_identifier_part)
}

fn read_quoted_pg_identifier(chars: &[char], start: usize) -> Option<(String, usize)> {
    if chars.get(start) != Some(&'"') {
        return None;
    }
    let mut value = String::new();
    let mut i = start + 1;
    while i < chars.len() {
        if chars[i] == '"' {
            if chars.get(i + 1) == Some(&'"') {
                value.push('"');
                i += 2;
                continue;
            }
            return Some((value, i + 1));
        }
        value.push(chars[i]);
        i += 1;
    }
    None
}

fn read_pg_dollar_quote_tag(chars: &[char], start: usize) -> Option<String> {
    if chars.get(start) != Some(&'$') {
        return None;
    }
    let mut end = start + 1;
    while end < chars.len() && chars[end] != '$' {
        end += 1;
    }
    if end >= chars.len() {
        return None;
    }
    let tag_body = &chars[start + 1..end];
    let valid = tag_body.is_empty()
        || (tag_body
            .first()
            .map(|c| c.is_ascii_alphabetic() || *c == '_')
            .unwrap_or(false)
            && tag_body
                .iter()
                .all(|c| c.is_ascii_alphanumeric() || *c == '_'));
    if valid {
        Some(chars[start..=end].iter().collect())
    } else {
        None
    }
}

fn push_until_line_end(out: &mut String, chars: &[char], mut i: usize) -> usize {
    while i < chars.len() {
        out.push(chars[i]);
        i += 1;
        if chars[i - 1] == '\n' {
            break;
        }
    }
    i
}

fn push_until_block_comment_end(out: &mut String, chars: &[char], mut i: usize) -> usize {
    while i < chars.len() {
        out.push(chars[i]);
        if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
            out.push('/');
            return i + 2;
        }
        i += 1;
    }
    i
}

fn push_single_quoted_literal(out: &mut String, chars: &[char], mut i: usize) -> usize {
    out.push(chars[i]);
    i += 1;
    while i < chars.len() {
        out.push(chars[i]);
        if chars[i] == '\'' {
            if chars.get(i + 1) == Some(&'\'') {
                out.push('\'');
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    i
}

fn push_dollar_quoted_literal(out: &mut String, chars: &[char], mut i: usize, tag: &str) -> usize {
    out.push_str(tag);
    i += tag.chars().count();
    while i < chars.len() {
        if starts_with_chars(chars, i, tag) {
            out.push_str(tag);
            return i + tag.chars().count();
        }
        out.push(chars[i]);
        i += 1;
    }
    i
}

fn strip_postgres_schema_qualifiers(ddl: &str, schema: &str) -> String {
    if schema.trim().is_empty() {
        return ddl.to_string();
    }

    let chars = ddl.chars().collect::<Vec<_>>();
    let schema_len = schema.chars().count();
    let bare_schema = is_pg_bare_identifier(schema);
    let mut out = String::with_capacity(ddl.len());
    let mut i = 0;

    while i < chars.len() {
        if chars[i] == '-' && chars.get(i + 1) == Some(&'-') {
            i = push_until_line_end(&mut out, &chars, i);
            continue;
        }
        if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
            i = push_until_block_comment_end(&mut out, &chars, i);
            continue;
        }
        if chars[i] == '\'' {
            i = push_single_quoted_literal(&mut out, &chars, i);
            continue;
        }
        if chars[i] == '$' {
            if let Some(tag) = read_pg_dollar_quote_tag(&chars, i) {
                i = push_dollar_quoted_literal(&mut out, &chars, i, &tag);
                continue;
            }
        }
        if let Some((quoted, end)) = read_quoted_pg_identifier(&chars, i) {
            if quoted == schema && chars.get(end) == Some(&'.') {
                i = end + 1;
                continue;
            }
            for c in &chars[i..end] {
                out.push(*c);
            }
            i = end;
            continue;
        }
        if bare_schema
            && starts_with_chars(&chars, i, schema)
            && chars.get(i + schema_len) == Some(&'.')
            && i.checked_sub(1)
                .and_then(|prev| chars.get(prev))
                .map(|c| !is_pg_identifier_part(*c) && *c != '.')
                .unwrap_or(true)
        {
            i += schema_len + 1;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }

    out
}

fn build_postgres_table_ddl(
    schema: &str,
    table: &str,
    columns: &[PgColumnMeta],
    primary_key: Option<&PgPrimaryKeyMeta>,
) -> String {
    let mut lines: Vec<String> =
        Vec::with_capacity(columns.len() + usize::from(primary_key.is_some()));
    for col in columns {
        let mut parts = vec![format!("  {} {}", pg_id(&col.name), col.data_type)];
        if !col.identity.is_empty() {
            let mode = if col.identity == "a" {
                "ALWAYS"
            } else {
                "BY DEFAULT"
            };
            parts.push(format!("GENERATED {} AS IDENTITY", mode));
        } else if !col.generated.is_empty() {
            if let Some(expr) = col
                .generated_expr
                .as_deref()
                .filter(|s| !s.trim().is_empty())
            {
                parts.push(format!("GENERATED ALWAYS AS ({}) STORED", expr));
            }
        } else if let Some(default_expr) = col.default_expr.as_deref().filter(|s| !s.is_empty()) {
            parts.push(format!("DEFAULT {}", default_expr));
        }
        if col.not_null {
            parts.push("NOT NULL".to_string());
        }
        lines.push(parts.join(" "));
    }
    if let Some(pk) = primary_key {
        let cols = pk
            .columns
            .iter()
            .map(|c| pg_id(c))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!(
            "  CONSTRAINT {} PRIMARY KEY ({})",
            pg_id(&pk.name),
            cols
        ));
    }
    let ddl = format!("CREATE TABLE {} (\n{}\n)", pg_id(table), lines.join(",\n"));
    strip_postgres_schema_qualifiers(&ddl, schema)
}

fn append_ddl(out: &mut String, ddl: &str) {
    if ddl.trim().is_empty() {
        return;
    }
    out.push_str(&ensure_semicolon(ddl));
    out.push('\n');
}

fn build_postgres_export_script(
    metadata: &PgExportMetadata,
    inserts: &[PgExportInsertBatch],
) -> Result<String, String> {
    if metadata.schema.trim().is_empty() {
        return Err("schema 名称不能为空".to_string());
    }

    let mut out = String::new();
    out.push_str("-- Exported by DB Connect\n");
    out.push_str("-- Source database type: PostgreSQL\n");
    out.push_str(
        "-- Import: choose target schema before import, or edit SET search_path below\n\n",
    );
    out.push_str(&format!(
        "CREATE SCHEMA IF NOT EXISTS {};\n",
        pg_id(&metadata.schema)
    ));
    out.push_str(&format!(
        "SET search_path TO {};\n\n",
        pg_id(&metadata.schema)
    ));

    if !metadata.tables.is_empty() {
        out.push_str("/* Tables */\n");
        for table in &metadata.tables {
            out.push_str(&format!("/* table {} */\n", pg_id(&table.name)));
            append_ddl(&mut out, &table.ddl);
            out.push('\n');
        }
    }

    if !metadata.routines.is_empty() {
        out.push_str("/* Functions and procedures */\n");
        for routine in &metadata.routines {
            out.push_str(&format!("/* routine {} */\n", routine.name));
            append_ddl(&mut out, &routine.ddl);
        }
        out.push('\n');
    }

    if !inserts.is_empty() {
        out.push_str("/* Data */\n");
        for batch in inserts {
            if batch.rows.is_empty() {
                continue;
            }
            let cols = batch
                .columns
                .iter()
                .map(|c| pg_id(c))
                .collect::<Vec<_>>()
                .join(", ");
            let values = batch
                .rows
                .iter()
                .map(|row| format!("({})", row.join(", ")))
                .collect::<Vec<_>>()
                .join(", ");
            out.push_str(&format!(
                "INSERT INTO {} ({}) VALUES {};\n",
                pg_id(&batch.table),
                cols,
                values
            ));
        }
        out.push('\n');
    }

    if !metadata.views.is_empty() {
        out.push_str("/* Views */\n");
        for view in &metadata.views {
            out.push_str(&format!("/* view {} */\n", pg_id(&view.name)));
            append_ddl(&mut out, &view.ddl);
            out.push('\n');
        }
    }

    if !metadata.indexes.is_empty() {
        out.push_str("/* Indexes */\n");
        for idx in &metadata.indexes {
            out.push_str(&format!("/* index {} */\n", pg_id(&idx.name)));
            append_ddl(&mut out, &idx.ddl);
        }
        out.push('\n');
    }

    if !metadata.foreign_keys.is_empty() {
        out.push_str("/* Foreign keys */\n");
        for fk in &metadata.foreign_keys {
            out.push_str(&format!("/* foreign key {} */\n", pg_id(&fk.name)));
            append_ddl(&mut out, &fk.ddl);
        }
        out.push('\n');
    }

    if !metadata.triggers.is_empty() {
        out.push_str("/* Triggers */\n");
        for trigger in &metadata.triggers {
            out.push_str(&format!("/* trigger {} */\n", pg_id(&trigger.name)));
            append_ddl(&mut out, &trigger.ddl);
        }
        out.push('\n');
    }

    Ok(out)
}

async fn load_postgres_export_metadata(
    pool: &deadpool_postgres::Pool,
    schema: &str,
) -> Result<PgExportMetadata, String> {
    let client = postgres::get_client_with_retry(pool).await?;

    let relation_rows = client
        .query(
            "SELECT c.relname AS name, c.relkind::text AS kind, \
                    CASE WHEN c.relkind IN ('v', 'm') THEN pg_catalog.pg_get_viewdef(c.oid, true) ELSE NULL END AS view_def \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm') \
             ORDER BY CASE WHEN c.relkind IN ('r', 'p') THEN 0 ELSE 1 END, c.relname",
            &[&schema],
        )
        .await
        .map_err(|e| format_pg_error("查询 PostgreSQL 表/视图", e))?;

    let column_rows = client
        .query(
            "SELECT c.relname AS table_name, a.attname AS column_name, \
                    pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type, \
                    a.attnotnull AS not_null, \
                    pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_expr, \
                    a.attidentity::text AS identity_kind, \
                    a.attgenerated::text AS generated_kind, \
                    COALESCE(pg_catalog.col_description(a.attrelid, a.attnum), '') AS comment \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid \
             LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
             WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') \
               AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY c.relname, a.attnum",
            &[&schema],
        )
        .await
        .map_err(|e| format_pg_error("查询 PostgreSQL 列", e))?;

    let mut columns_by_table: BTreeMap<String, Vec<PgColumnMeta>> = BTreeMap::new();
    for row in &column_rows {
        let table_name: String = row.get("table_name");
        let default_expr: Option<String> = row.get("default_expr");
        let generated: String = row.get("generated_kind");
        let generated_expr = if generated.trim().is_empty() {
            None
        } else {
            default_expr.clone()
        };
        columns_by_table
            .entry(table_name)
            .or_default()
            .push(PgColumnMeta {
                name: row.get("column_name"),
                data_type: row.get("data_type"),
                not_null: row.get("not_null"),
                default_expr: if generated.trim().is_empty() {
                    default_expr
                } else {
                    None
                },
                identity: row.get("identity_kind"),
                generated,
                generated_expr,
                comment: row.get("comment"),
            });
    }

    let primary_key_rows = client
        .query(
            "SELECT t.relname AS table_name, con.conname AS constraint_name, \
                    ARRAY(SELECT a.attname \
                          FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord) \
                          JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.attnum \
                          ORDER BY u.ord) AS column_names \
             FROM pg_catalog.pg_constraint con \
             JOIN pg_catalog.pg_class t ON t.oid = con.conrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace \
             WHERE n.nspname = $1 AND con.contype = 'p' \
             ORDER BY t.relname",
            &[&schema],
        )
        .await
        .map_err(|e| format_pg_error("查询 PostgreSQL 主键", e))?;

    let mut primary_keys: BTreeMap<String, PgPrimaryKeyMeta> = BTreeMap::new();
    for row in &primary_key_rows {
        primary_keys.insert(
            row.get("table_name"),
            PgPrimaryKeyMeta {
                name: row.get("constraint_name"),
                columns: row.get("column_names"),
            },
        );
    }

    let mut tables = Vec::new();
    let mut views = Vec::new();
    for row in &relation_rows {
        let name: String = row.get("name");
        let kind: String = row.get("kind");
        if kind == "r" || kind == "p" {
            let columns = columns_by_table.remove(&name).unwrap_or_default();
            let mut ddl =
                build_postgres_table_ddl(schema, &name, &columns, primary_keys.get(&name));
            for col in &columns {
                if !col.comment.trim().is_empty() {
                    ddl.push_str(";\n");
                    ddl.push_str(&format!(
                        "COMMENT ON COLUMN {}.{} IS {}",
                        pg_id(&name),
                        pg_id(&col.name),
                        crate::db::sql_utils::pg_str(&col.comment)
                    ));
                }
            }
            let column_names = columns.into_iter().map(|c| c.name).collect();
            tables.push(PgExportRelation {
                name,
                relation_kind: PgExportRelationKind::Table,
                ddl,
                columns: column_names,
            });
        } else {
            let view_def: Option<String> = row.get("view_def");
            let ddl = if kind == "m" {
                format!(
                    "CREATE MATERIALIZED VIEW {} AS\n{}",
                    pg_id(&name),
                    view_def.unwrap_or_default()
                )
            } else {
                format!(
                    "CREATE OR REPLACE VIEW {} AS\n{}",
                    pg_id(&name),
                    view_def.unwrap_or_default()
                )
            };
            views.push(PgExportRelation {
                name,
                relation_kind: PgExportRelationKind::View,
                ddl: strip_postgres_schema_qualifiers(&ddl, schema),
                columns: Vec::new(),
            });
        }
    }

    let index_rows = client
        .query(
            "SELECT i.relname AS name, pg_catalog.pg_get_indexdef(i.oid) AS ddl \
             FROM pg_catalog.pg_index ix \
             JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace \
             WHERE n.nspname = $1 AND NOT ix.indisprimary \
             ORDER BY t.relname, i.relname",
            &[&schema],
        )
        .await
        .map_err(|e| format_pg_error("查询 PostgreSQL 索引", e))?;
    let indexes = index_rows
        .iter()
        .map(|row| PgExportObject {
            name: row.get("name"),
            ddl: strip_postgres_schema_qualifiers(&row.get::<_, String>("ddl"), schema),
        })
        .collect();

    let fk_rows = client
        .query(
            "SELECT con.conname AS name, t.relname AS table_name, \
                    pg_catalog.pg_get_constraintdef(con.oid, true) AS constraint_def \
             FROM pg_catalog.pg_constraint con \
             JOIN pg_catalog.pg_class t ON t.oid = con.conrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace \
             WHERE n.nspname = $1 AND con.contype = 'f' \
             ORDER BY t.relname, con.conname",
            &[&schema],
        )
        .await
        .map_err(|e| format_pg_error("查询 PostgreSQL 外键", e))?;
    let foreign_keys = fk_rows
        .iter()
        .map(|row| {
            let table_name: String = row.get("table_name");
            let constraint_def: String = row.get("constraint_def");
            PgExportObject {
                name: row.get("name"),
                ddl: strip_postgres_schema_qualifiers(
                    &format!(
                        "ALTER TABLE {} ADD CONSTRAINT {} {}",
                        pg_id(&table_name),
                        pg_id(&row.get::<_, String>("name")),
                        constraint_def
                    ),
                    schema,
                ),
            }
        })
        .collect();

    let trigger_rows = client
        .query(
            "SELECT t.tgname AS name, pg_catalog.pg_get_triggerdef(t.oid, true) AS ddl \
             FROM pg_catalog.pg_trigger t \
             JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND NOT t.tgisinternal \
             ORDER BY c.relname, t.tgname",
            &[&schema],
        )
        .await
        .map_err(|e| format_pg_error("查询 PostgreSQL 触发器", e))?;
    let triggers = trigger_rows
        .iter()
        .map(|row| PgExportObject {
            name: row.get("name"),
            ddl: strip_postgres_schema_qualifiers(&row.get::<_, String>("ddl"), schema),
        })
        .collect();

    let routine_rows = client
        .query(
            "SELECT p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS name, \
                    pg_catalog.pg_get_functiondef(p.oid) AS ddl \
             FROM pg_catalog.pg_proc p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') \
             ORDER BY p.prokind, p.proname",
            &[&schema],
        )
        .await
        .map_err(|e| format_pg_error("查询 PostgreSQL 函数/过程", e))?;
    let routines = routine_rows
        .iter()
        .map(|row| PgExportObject {
            name: row.get("name"),
            ddl: strip_postgres_schema_qualifiers(&row.get::<_, String>("ddl"), schema),
        })
        .collect();

    Ok(PgExportMetadata {
        schema: schema.to_string(),
        tables,
        views,
        indexes,
        foreign_keys,
        triggers,
        routines,
    })
}

fn build_postgres_insert_value_select(columns: &[String]) -> String {
    columns
        .iter()
        .map(|c| format!("quote_nullable({})", pg_id(c)))
        .collect::<Vec<_>>()
        .join(", ")
}

fn build_postgres_insert_batch_query(
    schema: &str,
    tables: &[PgExportRelation],
    max_rows: u64,
) -> Option<String> {
    let parts = tables
        .iter()
        .enumerate()
        .filter(|(_, table)| !table.columns.is_empty())
        .map(|(idx, table)| {
            let value_select = build_postgres_insert_value_select(&table.columns);
            format!(
                "(SELECT {}::int AS table_order, {}::text AS table_name, ARRAY[{}] AS values_sql FROM {}.{} LIMIT {})",
                idx,
                pg_str(&table.name),
                value_select,
                pg_id(schema),
                pg_id(&table.name),
                max_rows
            )
        })
        .collect::<Vec<_>>();

    if parts.is_empty() {
        return None;
    }

    Some(format!(
        "SELECT table_name, values_sql FROM ({}) AS exported_rows ORDER BY table_order",
        parts.join(" UNION ALL ")
    ))
}

async fn load_postgres_insert_batches(
    client: &deadpool_postgres::Client,
    schema: &str,
    tables: &[PgExportRelation],
    max_rows: u64,
) -> Result<(Vec<PgExportInsertBatch>, u64), String> {
    let mut batches = Vec::new();
    let mut insert_rows = 0u64;

    let Some(sql) = build_postgres_insert_batch_query(schema, tables, max_rows) else {
        return Ok((batches, insert_rows));
    };
    let rows = client
        .query(&sql, &[])
        .await
        .map_err(|e| format_pg_error("导出 PostgreSQL 表数据", e))?;

    let mut rows_by_table: BTreeMap<String, Vec<Vec<String>>> = BTreeMap::new();
    for row in &rows {
        let table_name: String = row.get("table_name");
        let values_sql: Vec<String> = row.get("values_sql");
        insert_rows += 1;
        rows_by_table
            .entry(table_name)
            .or_default()
            .push(values_sql);
    }

    for table in tables {
        if let Some(value_rows) = rows_by_table.remove(&table.name) {
            batches.push(PgExportInsertBatch {
                table: table.name.clone(),
                columns: table.columns.clone(),
                rows: value_rows,
            });
        }
    }

    Ok((batches, insert_rows))
}

fn summarize_import_statement(stmt: &str) -> String {
    let normalized = stmt.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= MAX_IMPORT_FAILURE_STATEMENT_PREVIEW_CHARS {
        return normalized;
    }

    let mut preview = normalized
        .chars()
        .take(MAX_IMPORT_FAILURE_STATEMENT_PREVIEW_CHARS)
        .collect::<String>();
    preview.push_str("...");
    preview
}

fn record_import_failure(
    failures: &mut Vec<ImportSqlStatementFailure>,
    statement_index: u32,
    stmt: &str,
    error: String,
) {
    if failures.len() >= MAX_RECORDED_IMPORT_FAILURES {
        return;
    }
    failures.push(ImportSqlStatementFailure {
        statement_index,
        statement_preview: summarize_import_statement(stmt),
        error,
    });
}

/// 从用户选择的 UTF-8 SQL 文件依次执行语句（SELECT 类会执行并丢弃结果）。
#[tauri::command]
pub async fn import_sql_file(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
    file_path: String,
) -> Result<ImportSqlFileResult, String> {
    // 解析阶段：total=0 表示前端显示「解析中」
    let _ = app.emit(
        "sql-import-progress",
        SqlImportProgress {
            current: 0,
            total: 0,
        },
    );

    // 读取整文件（上限 512MB）与拆句都是阻塞型 IO/CPU 操作，放到 blocking 线程池，
    // 避免阻塞当前 Tokio worker 线程影响其它异步命令。
    let read_path = file_path.clone();
    let statements: Vec<String> = tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let path = Path::new(&read_path);
        let meta =
            std::fs::metadata(path).map_err(|e| format_fs_err("无法读取 SQL 文件信息", e))?;
        let file_len = meta.len();
        if file_len > MAX_IMPORT_FILE_BYTES {
            let cur_mb = file_len as f64 / (1024.0 * 1024.0);
            let max_mb = MAX_IMPORT_FILE_BYTES / (1024 * 1024);
            return Err(format!(
                "SQL 文件过大（当前约 {:.1} MB，单文件上限 {} MB）。可将文件拆分后分批导入，或使用 mysql 客户端导入。",
                cur_mb, max_mb
            ));
        }
        let bytes = std::fs::read(path).map_err(|e| format_fs_err("读取 SQL 文件失败", e))?;
        let bytes = strip_utf8_bom(&bytes);
        let text = std::str::from_utf8(bytes).map_err(|_| "文件不是有效 UTF-8 文本".to_string())?;
        Ok(split_sql_statements(text)
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect())
    })
    .await
    .map_err(|e| format!("读取 SQL 文件任务失败: {}", e))??;

    let total = statements.len() as u32;
    if total == 0 {
        return Err("未解析到任何 SQL 语句".to_string());
    }

    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let start = Instant::now();
    let mut ok: u32 = 0;
    let mut failed: u32 = 0;
    let mut failures: Vec<ImportSqlStatementFailure> = Vec::new();
    let _ = app.emit(
        "sql-import-progress",
        SqlImportProgress { current: 0, total },
    );

    match pool_handle {
        DatabasePoolHandle::MySql(pool) => {
            let mut conn = get_conn_with_retry(&pool).await?;
            if let Some(ref db) = database {
                if !db.is_empty() {
                    conn.query_drop(format!("USE {}", esc_id(db)))
                        .await
                        .map_err(|e| format!("切换数据库失败: {}", e))?;
                }
            }

            for (i, stmt) in statements.iter().enumerate() {
                match run_one_statement(&mut conn, stmt).await {
                    Ok(()) => ok += 1,
                    Err(e) => {
                        failed += 1;
                        record_import_failure(&mut failures, (i + 1) as u32, stmt, e);
                    }
                }
                let done = (i + 1) as u32;
                if done == 1
                    || done == total
                    || done.is_multiple_of(IMPORT_PROGRESS_EMIT_INTERVAL as u32)
                {
                    let _ = app.emit(
                        "sql-import-progress",
                        SqlImportProgress {
                            current: done,
                            total,
                        },
                    );
                }
            }
        }
        DatabasePoolHandle::Postgres(handle) => {
            let client = postgres::get_client_with_retry(&handle.pool).await?;
            postgres::set_search_path_if_set(&client, &database).await?;

            for (i, stmt) in statements.iter().enumerate() {
                match run_one_postgres_statement(&client, stmt).await {
                    Ok(()) => ok += 1,
                    Err(e) => {
                        failed += 1;
                        record_import_failure(&mut failures, (i + 1) as u32, stmt, e);
                    }
                }
                let done = (i + 1) as u32;
                if done == 1
                    || done == total
                    || done.is_multiple_of(IMPORT_PROGRESS_EMIT_INTERVAL as u32)
                {
                    let _ = app.emit(
                        "sql-import-progress",
                        SqlImportProgress {
                            current: done,
                            total,
                        },
                    );
                }
            }
        }
        DatabasePoolHandle::Sqlite(_) => {
            return Err(DatabasePoolHandle::sqlite_unsupported_error());
        }
    }

    let _ = app.emit(
        "sql-import-progress",
        SqlImportProgress {
            current: total,
            total,
        },
    );

    Ok(ImportSqlFileResult {
        statements_total: total,
        statements_ok: ok,
        statements_failed: failed,
        failures,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

fn format_cell_for_export(v: Option<&MyValue>) -> String {
    match v {
        None => "NULL".to_string(),
        Some(MyValue::NULL) => "NULL".to_string(),
        Some(MyValue::Int(i)) => i.to_string(),
        Some(MyValue::UInt(u)) => u.to_string(),
        Some(MyValue::Float(f)) => format!("{}", f),
        Some(MyValue::Double(d)) => format!("{}", d),
        Some(MyValue::Bytes(b)) => {
            if let Ok(s) = std::str::from_utf8(b) {
                esc_str(s)
            } else {
                let hex: String = b.iter().map(|x| format!("{:02X}", x)).collect();
                format!("X'{}'", hex)
            }
        }
        Some(MyValue::Date(y, m, d, h, mi, s, us)) => {
            if *h == 0 && *mi == 0 && *s == 0 && *us == 0 {
                esc_str(&format!("{:04}-{:02}-{:02}", y, m, d))
            } else {
                esc_str(&format!(
                    "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:06}",
                    y, m, d, h, mi, s, us
                ))
            }
        }
        Some(MyValue::Time(neg, days, h, mi, s, us)) => {
            let sign = if *neg { "-" } else { "" };
            let total_hours = *days * 24 + (*h as u32);
            esc_str(&format!(
                "{}{:}:{:02}:{:02}.{:06}",
                sign, total_hours, mi, s, us
            ))
        }
    }
}

fn write_insert_batch<W: Write>(
    file: &mut W,
    table: &str,
    col_names: &[String],
    cols_sql: &str,
    batch: &[mysql_async::Row],
) -> Result<(), String> {
    // 仅表名，依赖导入端已 USE 目标库（与本应用导入行为一致）
    let table_ref = esc_id(table);
    let mut values_parts: Vec<String> = Vec::new();
    for row in batch {
        let mut vals: Vec<String> = Vec::new();
        for i in 0..col_names.len() {
            vals.push(format_cell_for_export(row.as_ref(i)));
        }
        values_parts.push(format!("({})", vals.join(", ")));
    }
    writeln!(
        file,
        "INSERT INTO {} ({}) VALUES {};",
        table_ref,
        cols_sql,
        values_parts.join(", ")
    )
    .map_err(|e| format_fs_err("写入导出文件失败", e))?;
    Ok(())
}

async fn export_postgres_database_to_file_impl(
    app: &AppHandle,
    pool: &deadpool_postgres::Pool,
    schema: &str,
    file_path: String,
    include_data: bool,
    max_rows: u64,
    mut file: BufWriter<std::fs::File>,
) -> Result<ExportSqlFileResult, String> {
    let start = Instant::now();
    let metadata = load_postgres_export_metadata(pool, schema).await?;
    let metadata_steps = metadata.tables.len()
        + metadata.views.len()
        + metadata.indexes.len()
        + metadata.foreign_keys.len()
        + metadata.triggers.len()
        + metadata.routines.len();
    let data_steps = if include_data {
        metadata.tables.len()
    } else {
        0
    };
    let total_steps_u32 = (metadata_steps + data_steps).max(1) as u32;
    let _ = app.emit(
        "sql-export-progress",
        SqlExportProgress {
            current: 0,
            total: total_steps_u32,
        },
    );

    let (inserts, insert_rows) = if include_data {
        let client = postgres::get_client_with_retry(pool).await?;
        load_postgres_insert_batches(&client, schema, &metadata.tables, max_rows).await?
    } else {
        (Vec::new(), 0)
    };

    let script = build_postgres_export_script(&metadata, &inserts)?;
    file.write_all(script.as_bytes())
        .map_err(|e| format_fs_err("写入导出文件失败", e))?;
    file.flush()
        .map_err(|e| format_fs_err("写入导出文件失败", e))?;
    drop(file);

    let path = Path::new(&file_path);
    crate::util::secure_fs::set_secure_file_permissions(path)
        .map_err(|e| format!("设置文件权限失败: {}", e))?;

    let _ = app.emit(
        "sql-export-progress",
        SqlExportProgress {
            current: total_steps_u32,
            total: total_steps_u32,
        },
    );

    Ok(ExportSqlFileResult {
        tables_exported: metadata.tables.len() as u32,
        views_exported: metadata.views.len() as u32,
        triggers_exported: metadata.triggers.len() as u32,
        events_exported: 0,
        insert_rows,
        file_path,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

/// 将当前库导出为 .sql（表/视图的 CREATE；可选导出表数据为 INSERT，每表最多 `max_rows_per_table` 行）。
#[tauri::command]
pub async fn export_database_to_file(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    file_path: String,
    include_data: bool,
    max_rows_per_table: u32,
) -> Result<ExportSqlFileResult, String> {
    if database.trim().is_empty() {
        return Err("请选择要导出的数据库".to_string());
    }
    let max_rows = max_rows_per_table.clamp(1, 1_000_000u32) as u64;

    let path = Path::new(&file_path);
    // 用 BufWriter 包裹：导出大量 INSERT 时合并写入，避免每条 writeln! 都触发一次系统调用
    let mut file = BufWriter::new(
        std::fs::File::create(path).map_err(|e| format_fs_err("创建导出文件失败", e))?,
    );

    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_and_touch(&conn_id)?
    };
    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            return export_postgres_database_to_file_impl(
                &app,
                &handle.pool,
                &database,
                file_path,
                include_data,
                max_rows,
                file,
            )
            .await;
        }
        DatabasePoolHandle::Sqlite(_) => {
            return Err(DatabasePoolHandle::sqlite_unsupported_error());
        }
    };
    let mut conn = get_conn_with_retry(&pool).await?;

    let query = format!("SHOW TABLE STATUS FROM {}", esc_id(&database));
    let rows: Vec<mysql_async::Row> = conn
        .query(&query)
        .await
        .map_err(|e| format!("列出表失败: {}", e))?;

    let mut tables: Vec<TableInfo> = rows
        .iter()
        .map(|row| {
            let engine: Option<String> = row.get("Engine").flatten();
            let table_type = if engine.is_some() {
                "TABLE".to_string()
            } else {
                "VIEW".to_string()
            };
            TableInfo {
                name: row
                    .get::<Option<String>, _>("Name")
                    .flatten()
                    .unwrap_or_default(),
                table_type,
                engine,
                rows: row.get::<Option<u64>, _>("Rows").flatten(),
                data_length: row.get::<Option<u64>, _>("Data_length").flatten(),
                index_length: row.get::<Option<u64>, _>("Index_length").flatten(),
                comment: row
                    .get::<Option<String>, _>("Comment")
                    .flatten()
                    .unwrap_or_default(),
            }
        })
        .collect();

    tables.sort_by(|a, b| {
        let oa = if a.table_type == "TABLE" { 0 } else { 1 };
        let ob = if b.table_type == "TABLE" { 0 } else { 1 };
        oa.cmp(&ob).then_with(|| a.name.cmp(&b.name))
    });

    let trig_q = format!("SHOW TRIGGERS FROM {}", esc_id(&database));
    let trig_rows: Vec<mysql_async::Row> = conn
        .query(&trig_q)
        .await
        .map_err(|e| format!("列出触发器失败: {}", e))?;

    let mut trigger_names: Vec<String> = trig_rows
        .iter()
        .filter_map(|row| row.get::<Option<String>, _>("Trigger").flatten())
        .collect();
    trigger_names.sort();
    trigger_names.dedup();

    let ev_q = format!("SHOW EVENTS FROM {}", esc_id(&database));
    let ev_rows: Vec<mysql_async::Row> = conn
        .query(&ev_q)
        .await
        .map_err(|e| format!("列出定时事件失败: {}", e))?;

    let mut event_names: Vec<String> = ev_rows
        .iter()
        .filter_map(|row| row.get::<Option<String>, _>("Name").flatten())
        .collect();
    event_names.sort();
    event_names.dedup();

    let total_steps = tables.len() + trigger_names.len() + event_names.len();
    let total_steps_u32 = total_steps as u32;
    let _ = app.emit(
        "sql-export-progress",
        SqlExportProgress {
            current: 0,
            total: total_steps_u32.max(1),
        },
    );

    let start = Instant::now();

    writeln!(file, "-- Exported by DB Connect")
        .map_err(|e| format_fs_err("写入导出文件失败", e))?;
    writeln!(
        file,
        "-- Source database (metadata only): {} | include_data: {} | max_rows_per_table: {}",
        database, include_data, max_rows
    )
    .map_err(|e| format_fs_err("写入导出文件失败", e))?;
    writeln!(
        file,
        "-- Import: choose target database in app before import, or add a USE your_db line yourself"
    )
    .map_err(|e| format_fs_err("写入导出文件失败", e))?;
    writeln!(file, "SET NAMES utf8mb4;").map_err(|e| format_fs_err("写入导出文件失败", e))?;
    writeln!(file, "SET FOREIGN_KEY_CHECKS=0;")
        .map_err(|e| format_fs_err("写入导出文件失败", e))?;
    writeln!(file).map_err(|e| format_fs_err("写入导出文件失败", e))?;

    let mut tables_exported: u32 = 0;
    let mut views_exported: u32 = 0;
    let mut insert_rows: u64 = 0;
    let mut triggers_exported: u32 = 0;
    let mut events_exported: u32 = 0;
    let mut step: u32 = 0;

    for t in &tables {
        let create_q = format!(
            "SHOW CREATE TABLE {}.{}",
            esc_id(&database),
            esc_id(&t.name)
        );
        let crows: Vec<mysql_async::Row> = conn
            .query(&create_q)
            .await
            .map_err(|e| format!("SHOW CREATE TABLE `{}` 失败: {}", t.name, e))?;

        let ddl = crows.first().and_then(|row| {
            row.get::<Option<String>, _>("Create Table")
                .flatten()
                .or_else(|| row.get::<Option<String>, _>("Create View").flatten())
        });

        if let Some(ddl) = ddl {
            let ddl = strip_export_schema_qualifiers(&ddl, &database);

            writeln!(file).map_err(|e| format_fs_err("写入导出文件失败", e))?;
            writeln!(file, "/* `{}` */", t.name)
                .map_err(|e| format_fs_err("写入导出文件失败", e))?;
            writeln!(file, "{};", ddl).map_err(|e| format_fs_err("写入导出文件失败", e))?;

            if t.table_type == "TABLE" {
                tables_exported += 1;
            } else {
                views_exported += 1;
            }

            if include_data && t.table_type == "TABLE" {
                let data_q = format!(
                    "SELECT * FROM {}.{} LIMIT {}",
                    esc_id(&database),
                    esc_id(&t.name),
                    max_rows
                );
                // 流式读取：逐行从结果集拉取并按 batch 写文件，避免一次性把整表（上限百万行）载入内存
                let mut result = conn
                    .query_iter(&data_q)
                    .await
                    .map_err(|e| format!("导出表 `{}` 数据失败: {}", t.name, e))?;

                let mut col_names: Vec<String> = Vec::new();
                let mut cols_sql = String::new();
                let mut batch: Vec<mysql_async::Row> = Vec::with_capacity(EXPORT_INSERT_BATCH);

                loop {
                    let row = match result
                        .next()
                        .await
                        .map_err(|e| format!("导出表 `{}` 数据失败: {}", t.name, e))?
                    {
                        Some(r) => r,
                        None => break,
                    };
                    if col_names.is_empty() {
                        col_names = row
                            .columns_ref()
                            .iter()
                            .map(|c| c.name_str().to_string())
                            .collect();
                        cols_sql = col_names
                            .iter()
                            .map(|c| esc_id(c))
                            .collect::<Vec<_>>()
                            .join(", ");
                    }
                    batch.push(row);
                    if batch.len() >= EXPORT_INSERT_BATCH {
                        write_insert_batch(&mut file, &t.name, &col_names, &cols_sql, &batch)?;
                        insert_rows += batch.len() as u64;
                        batch.clear();
                    }
                }
                if !batch.is_empty() {
                    write_insert_batch(&mut file, &t.name, &col_names, &cols_sql, &batch)?;
                    insert_rows += batch.len() as u64;
                }
            }
        }

        step += 1;
        let _ = app.emit(
            "sql-export-progress",
            SqlExportProgress {
                current: step,
                total: total_steps_u32.max(1),
            },
        );
    }

    if !trigger_names.is_empty() {
        writeln!(file).map_err(|e| format_fs_err("写入导出文件失败", e))?;
        writeln!(file, "/* Triggers */").map_err(|e| format_fs_err("写入导出文件失败", e))?;
        for name in &trigger_names {
            let def_q = format!("SHOW CREATE TRIGGER {}.{}", esc_id(&database), esc_id(name));
            let def_rows: Vec<mysql_async::Row> = conn
                .query(&def_q)
                .await
                .map_err(|e| format!("SHOW CREATE TRIGGER `{}` 失败: {}", name, e))?;
            if let Some(row) = def_rows.first() {
                let ddl: Option<String> = row
                    .get::<Option<String>, _>("SQL Original Statement")
                    .flatten();
                if let Some(ddl) = ddl {
                    let ddl = strip_export_schema_qualifiers(&ddl, &database);
                    writeln!(file).map_err(|e| format_fs_err("写入导出文件失败", e))?;
                    writeln!(file, "/* trigger `{}` */", name)
                        .map_err(|e| format_fs_err("写入导出文件失败", e))?;
                    writeln!(file, "{};", ddl).map_err(|e| format_fs_err("写入导出文件失败", e))?;
                    triggers_exported += 1;
                }
            }
            step += 1;
            let _ = app.emit(
                "sql-export-progress",
                SqlExportProgress {
                    current: step,
                    total: total_steps_u32.max(1),
                },
            );
        }
    }

    if !event_names.is_empty() {
        writeln!(file).map_err(|e| format_fs_err("写入导出文件失败", e))?;
        writeln!(file, "/* Events (event_scheduler) */")
            .map_err(|e| format_fs_err("写入导出文件失败", e))?;
        for ev_name in &event_names {
            let def_q = format!(
                "SHOW CREATE EVENT {}.{}",
                esc_id(&database),
                esc_id(ev_name)
            );
            let def_rows: Vec<mysql_async::Row> = conn
                .query(&def_q)
                .await
                .map_err(|e| format!("SHOW CREATE EVENT `{}` 失败: {}", ev_name, e))?;
            if let Some(row) = def_rows.first() {
                let ddl: Option<String> = row.get::<Option<String>, _>("Create Event").flatten();
                if let Some(ddl) = ddl {
                    let ddl = strip_export_schema_qualifiers(&ddl, &database);
                    writeln!(file).map_err(|e| format_fs_err("写入导出文件失败", e))?;
                    writeln!(file, "/* event `{}` */", ev_name)
                        .map_err(|e| format_fs_err("写入导出文件失败", e))?;
                    writeln!(file, "{};", ddl).map_err(|e| format_fs_err("写入导出文件失败", e))?;
                    events_exported += 1;
                }
            }
            step += 1;
            let _ = app.emit(
                "sql-export-progress",
                SqlExportProgress {
                    current: step,
                    total: total_steps_u32.max(1),
                },
            );
        }
    }

    let _ = app.emit(
        "sql-export-progress",
        SqlExportProgress {
            current: total_steps_u32.max(1),
            total: total_steps_u32.max(1),
        },
    );

    writeln!(file).map_err(|e| format_fs_err("写入导出文件失败", e))?;
    writeln!(file, "SET FOREIGN_KEY_CHECKS=1;")
        .map_err(|e| format_fs_err("写入导出文件失败", e))?;

    // 显式 flush 缓冲并落盘，避免 BufWriter 在 drop 时静默吞掉写入错误
    file.flush()
        .map_err(|e| format_fs_err("写入导出文件失败", e))?;
    drop(file);

    crate::util::secure_fs::set_secure_file_permissions(path)
        .map_err(|e| format!("设置文件权限失败: {}", e))?;

    Ok(ExportSqlFileResult {
        tables_exported,
        views_exported,
        triggers_exported,
        events_exported,
        insert_rows,
        file_path,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod format_fs_err_tests {
    use super::*;

    #[test]
    fn permission_denied_hint_in_message() {
        let e = std::io::Error::new(ErrorKind::PermissionDenied, "test");
        let s = format_fs_err("创建导出文件失败", e);
        assert!(s.contains("权限"), "{}", s);
    }

    #[test]
    fn postgres_export_script_includes_schema_objects_and_insert_data() {
        let metadata = PgExportMetadata {
            schema: "app".to_string(),
            tables: vec![PgExportRelation {
                name: "users".to_string(),
                relation_kind: PgExportRelationKind::Table,
                ddl: "CREATE TABLE \"users\" (\"id\" integer PRIMARY KEY, \"name\" text)"
                    .to_string(),
                columns: vec!["id".to_string(), "name".to_string()],
            }],
            views: vec![PgExportRelation {
                name: "active_users".to_string(),
                relation_kind: PgExportRelationKind::View,
                ddl: "CREATE VIEW \"active_users\" AS SELECT id, name FROM users WHERE active"
                    .to_string(),
                columns: Vec::new(),
            }],
            indexes: vec![PgExportObject {
                name: "idx_users_name".to_string(),
                ddl: "CREATE INDEX \"idx_users_name\" ON \"users\" (\"name\")".to_string(),
            }],
            foreign_keys: vec![PgExportObject {
                name: "fk_users_org".to_string(),
                ddl: "ALTER TABLE \"users\" ADD CONSTRAINT \"fk_users_org\" FOREIGN KEY (\"org_id\") REFERENCES \"orgs\" (\"id\")"
                    .to_string(),
            }],
            triggers: vec![PgExportObject {
                name: "users_touch".to_string(),
                ddl: "CREATE TRIGGER \"users_touch\" BEFORE UPDATE ON \"users\" FOR EACH ROW EXECUTE FUNCTION touch_updated_at()"
                    .to_string(),
            }],
            routines: vec![PgExportObject {
                name: "touch_updated_at()".to_string(),
                ddl: "CREATE FUNCTION \"touch_updated_at\"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$"
                    .to_string(),
            }],
        };
        let inserts = vec![PgExportInsertBatch {
            table: "users".to_string(),
            columns: vec!["id".to_string(), "name".to_string()],
            rows: vec![
                vec!["1".to_string(), "'Ada'".to_string()],
                vec!["2".to_string(), "'Bob'".to_string()],
            ],
        }];

        let script = build_postgres_export_script(&metadata, &inserts).unwrap();

        assert!(script.contains("CREATE SCHEMA IF NOT EXISTS \"app\";"));
        assert!(script.contains("SET search_path TO \"app\";"));
        assert!(script.contains("CREATE TABLE \"users\""));
        assert!(script.contains("CREATE VIEW \"active_users\""));
        assert!(script.contains("CREATE INDEX \"idx_users_name\""));
        assert!(script.contains("ADD CONSTRAINT \"fk_users_org\""));
        assert!(script.contains("CREATE TRIGGER \"users_touch\""));
        assert!(script.contains("CREATE FUNCTION \"touch_updated_at\"()"));
        assert!(script
            .contains("INSERT INTO \"users\" (\"id\", \"name\") VALUES (1, 'Ada'), (2, 'Bob');"));
        assert!(!script.contains("FOREIGN_KEY_CHECKS"));
        assert!(!script.contains("SET NAMES"));
    }

    #[test]
    fn postgres_export_script_places_routines_before_dependent_triggers() {
        let metadata = PgExportMetadata {
            schema: "app".to_string(),
            tables: vec![PgExportRelation {
                name: "users".to_string(),
                relation_kind: PgExportRelationKind::Table,
                ddl: "CREATE TABLE \"users\" (\"id\" integer PRIMARY KEY)".to_string(),
                columns: vec!["id".to_string()],
            }],
            views: Vec::new(),
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            triggers: vec![PgExportObject {
                name: "users_touch".to_string(),
                ddl: "CREATE TRIGGER \"users_touch\" BEFORE UPDATE ON \"users\" FOR EACH ROW EXECUTE FUNCTION touch_updated_at()"
                    .to_string(),
            }],
            routines: vec![PgExportObject {
                name: "touch_updated_at()".to_string(),
                ddl: "CREATE FUNCTION \"touch_updated_at\"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$"
                    .to_string(),
            }],
        };

        let script = build_postgres_export_script(&metadata, &[]).unwrap();
        let routine_pos = script.find("CREATE FUNCTION").expect("routine DDL");
        let trigger_pos = script.find("CREATE TRIGGER").expect("trigger DDL");

        assert!(
            routine_pos < trigger_pos,
            "routine must be created before trigger:\n{}",
            script
        );
    }

    #[test]
    fn postgres_export_script_places_data_before_foreign_keys_and_triggers() {
        let metadata = PgExportMetadata {
            schema: "app".to_string(),
            tables: vec![
                PgExportRelation {
                    name: "orders".to_string(),
                    relation_kind: PgExportRelationKind::Table,
                    ddl: "CREATE TABLE \"orders\" (\"id\" integer PRIMARY KEY, \"user_id\" integer)"
                        .to_string(),
                    columns: vec!["id".to_string(), "user_id".to_string()],
                },
                PgExportRelation {
                    name: "users".to_string(),
                    relation_kind: PgExportRelationKind::Table,
                    ddl: "CREATE TABLE \"users\" (\"id\" integer PRIMARY KEY)".to_string(),
                    columns: vec!["id".to_string()],
                },
            ],
            views: Vec::new(),
            indexes: Vec::new(),
            foreign_keys: vec![PgExportObject {
                name: "orders_user_id_fkey".to_string(),
                ddl: "ALTER TABLE \"orders\" ADD CONSTRAINT \"orders_user_id_fkey\" FOREIGN KEY (\"user_id\") REFERENCES \"users\" (\"id\")"
                    .to_string(),
            }],
            triggers: vec![PgExportObject {
                name: "orders_touch".to_string(),
                ddl: "CREATE TRIGGER \"orders_touch\" BEFORE UPDATE ON \"orders\" FOR EACH ROW EXECUTE FUNCTION touch_updated_at()"
                    .to_string(),
            }],
            routines: vec![PgExportObject {
                name: "touch_updated_at()".to_string(),
                ddl: "CREATE FUNCTION \"touch_updated_at\"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$"
                    .to_string(),
            }],
        };
        let inserts = vec![
            PgExportInsertBatch {
                table: "orders".to_string(),
                columns: vec!["id".to_string(), "user_id".to_string()],
                rows: vec![vec!["10".to_string(), "1".to_string()]],
            },
            PgExportInsertBatch {
                table: "users".to_string(),
                columns: vec!["id".to_string()],
                rows: vec![vec!["1".to_string()]],
            },
        ];

        let script = build_postgres_export_script(&metadata, &inserts).unwrap();
        let insert_pos = script.find("INSERT INTO").expect("insert data");
        let fk_pos = script.find("ADD CONSTRAINT").expect("foreign key DDL");
        let trigger_pos = script.find("CREATE TRIGGER").expect("trigger DDL");

        assert!(
            insert_pos < fk_pos,
            "data should load before foreign keys:\n{}",
            script
        );
        assert!(
            insert_pos < trigger_pos,
            "data should load before triggers:\n{}",
            script
        );
    }

    #[test]
    fn postgres_schema_qualifier_stripping_preserves_literals_comments_and_dollar_bodies() {
        let ddl = "CREATE VIEW public.v AS SELECT 'public.users' AS literal, col FROM public.users;\n\
                   -- public.comment should remain\n\
                   SELECT $$public.inside_body$$ AS body, \"public\".\"orders\".id FROM \"public\".\"orders\";";

        let stripped = strip_postgres_schema_qualifiers(ddl, "public");

        assert!(
            stripped.contains("'public.users' AS literal"),
            "{}",
            stripped
        );
        assert!(
            stripped.contains("-- public.comment should remain"),
            "{}",
            stripped
        );
        assert!(
            stripped.contains("$$public.inside_body$$ AS body"),
            "{}",
            stripped
        );
        assert!(stripped.contains("FROM users"), "{}", stripped);
        assert!(stripped.contains("FROM \"orders\""), "{}", stripped);
        assert!(!stripped.contains("FROM public.users"), "{}", stripped);
        assert!(
            !stripped.contains("FROM \"public\".\"orders\""),
            "{}",
            stripped
        );
    }

    #[test]
    fn import_failure_records_statement_preview() {
        let mut failures = Vec::new();

        record_import_failure(
            &mut failures,
            2,
            "  CREATE TABLE users (\n    id integer primary key\n  )  ",
            "syntax error".to_string(),
        );

        assert_eq!(failures[0].statement_index, 2);
        assert_eq!(
            failures[0].statement_preview,
            "CREATE TABLE users ( id integer primary key )"
        );
        assert_eq!(failures[0].error, "syntax error");
    }

    #[test]
    fn postgres_insert_data_query_batches_all_tables_once() {
        let tables = vec![
            PgExportRelation {
                name: "users".to_string(),
                relation_kind: PgExportRelationKind::Table,
                ddl: String::new(),
                columns: vec!["id".to_string(), "name".to_string()],
            },
            PgExportRelation {
                name: "orders".to_string(),
                relation_kind: PgExportRelationKind::Table,
                ddl: String::new(),
                columns: vec!["id".to_string(), "user_id".to_string()],
            },
        ];

        let sql = build_postgres_insert_batch_query("app", &tables, 100).expect("query");

        assert!(sql.contains("'users'::text AS table_name"));
        assert!(sql.contains("'orders'::text AS table_name"));
        assert!(sql.contains("FROM \"app\".\"users\" LIMIT 100"));
        assert!(sql.contains("FROM \"app\".\"orders\" LIMIT 100"));
        assert!(sql.contains("UNION ALL"));
        assert!(sql.contains("ORDER BY table_order"));
    }
}
