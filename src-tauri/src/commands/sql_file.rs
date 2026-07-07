use crate::db::clickhouse;
use crate::db::connection::{get_conn_with_retry, DatabasePoolHandle};
use crate::db::postgres;
use crate::db::postgres_ddl::format_pg_error;
use crate::db::sql_script::split_sql_statements;
use crate::db::sql_utils::{
    esc_id, esc_str, pg_id, pg_str, sqlserver_id, sqlserver_str, strip_export_schema_qualifiers,
};
use crate::db::sqlite;
use crate::db::sqlserver;
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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct DangerousSqlStatementPreview {
    statement_index: u32,
    statement_preview: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct PreviewSqlFileImportResult {
    statements_total: u32,
    dangerous_statements_total: u32,
    dangerous_statements: Vec<DangerousSqlStatementPreview>,
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

async fn run_one_sqlserver_batch(
    client: &mut bb8::PooledConnection<'_, bb8_tiberius::ConnectionManager>,
    batch: &str,
) -> Result<(), String> {
    client
        .simple_query(batch)
        .await
        .map_err(|e| sqlserver::normalize_sqlserver_error("导入 SQL", e.to_string()))?
        .into_results()
        .await
        .map(|_| ())
        .map_err(|e| sqlserver::normalize_sqlserver_error("导入 SQL", e.to_string()))
}

async fn run_one_clickhouse_statement(
    client: &clickhouse_rs::Client,
    stmt: &str,
) -> Result<(), String> {
    clickhouse::run_sql_on_client(client, stmt, false, Instant::now())
        .await
        .map(|_| ())
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlServerExportDataColumn {
    name: String,
    data_type: String,
    is_identity: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlServerExportRelation {
    name: String,
    ddl: String,
    columns: Vec<SqlServerExportDataColumn>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlServerExportObject {
    name: String,
    ddl: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlServerExportMetadata {
    schema: String,
    tables: Vec<SqlServerExportRelation>,
    views: Vec<SqlServerExportObject>,
    indexes: Vec<SqlServerExportObject>,
    foreign_keys: Vec<SqlServerExportObject>,
    triggers: Vec<SqlServerExportObject>,
    routines: Vec<SqlServerExportObject>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlServerExportInsertBatch {
    table: String,
    columns: Vec<SqlServerExportDataColumn>,
    rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone)]
struct SqlServerColumnMeta {
    name: String,
    data_type: String,
    nullable: bool,
    default_constraint: Option<String>,
    default_expr: Option<String>,
    is_identity: bool,
    identity_seed: Option<String>,
    identity_increment: Option<String>,
    computed_expr: Option<String>,
    computed_persisted: bool,
}

#[derive(Debug, Clone)]
struct SqlServerPrimaryKeyMeta {
    name: String,
    columns: Vec<(String, bool)>,
}

#[derive(Debug, Clone)]
struct SqlServerIndexMeta {
    table_name: String,
    index_name: String,
    unique: bool,
    index_type: String,
    filter_definition: Option<String>,
    key_columns: Vec<(String, bool)>,
    included_columns: Vec<String>,
}

#[derive(Debug, Clone)]
struct SqlServerForeignKeyMeta {
    name: String,
    table_name: String,
    referenced_schema: String,
    referenced_table: String,
    delete_action: String,
    update_action: String,
    columns: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ClickHouseExportRelationKind {
    Table,
    View,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ClickHouseExportRelation {
    name: String,
    relation_kind: ClickHouseExportRelationKind,
    ddl: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ClickHouseExportMetadata {
    database: String,
    tables: Vec<ClickHouseExportRelation>,
    views: Vec<ClickHouseExportRelation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ClickHouseExportDataBlock {
    table: String,
    rows_sql: String,
    row_count: u64,
}

#[derive(Debug, serde::Deserialize)]
struct ClickHouseExportTableRow {
    name: String,
    object_type: String,
    create_table_query: String,
}

struct ClickHouseExportRequest<'a> {
    database: &'a str,
    file_path: String,
    include_data: bool,
    max_rows: u64,
    file: BufWriter<std::fs::File>,
    cancel_token: Option<&'a SqlExportCancelToken>,
}

#[derive(Debug, Clone)]
struct SqlExportCancelToken {
    cancelled: Arc<AtomicBool>,
}

impl SqlExportCancelToken {
    fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    fn from_arc(cancelled: Arc<AtomicBool>) -> Self {
        Self { cancelled }
    }

    fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancelled)
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err("导出已取消".to_string())
        } else {
            Ok(())
        }
    }
}

fn ensure_semicolon(sql: &str) -> String {
    let trimmed = sql.trim();
    if trimmed.ends_with(';') {
        trimmed.to_string()
    } else {
        format!("{};", trimmed)
    }
}

#[derive(Debug, Default, Clone)]
struct SqlServerBatchParseState {
    in_single: bool,
    in_double: bool,
    in_bracket: bool,
    in_block_comment: bool,
}

fn sqlserver_go_repeat_count(line: &str) -> Option<usize> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_comment = trimmed
        .split_once("--")
        .map(|(head, _)| head.trim())
        .unwrap_or(trimmed);
    let mut parts = without_comment.split_whitespace();
    let first = parts.next()?;
    if !first.eq_ignore_ascii_case("GO") {
        return None;
    }
    let Some(count) = parts.next() else {
        return Some(1);
    };
    if parts.next().is_some() {
        return None;
    }
    let count = count.parse::<usize>().ok()?;
    (count > 0).then_some(count)
}

fn update_sqlserver_batch_parse_state(line: &str, state: &mut SqlServerBatchParseState) {
    let chars = line.chars().collect::<Vec<_>>();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];

        if state.in_block_comment {
            if c == '*' && chars.get(i + 1) == Some(&'/') {
                state.in_block_comment = false;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        if state.in_single {
            if c == '\'' {
                if chars.get(i + 1) == Some(&'\'') {
                    i += 2;
                } else {
                    state.in_single = false;
                    i += 1;
                }
            } else {
                i += 1;
            }
            continue;
        }
        if state.in_double {
            if c == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    i += 2;
                } else {
                    state.in_double = false;
                    i += 1;
                }
            } else {
                i += 1;
            }
            continue;
        }
        if state.in_bracket {
            if c == ']' {
                if chars.get(i + 1) == Some(&']') {
                    i += 2;
                } else {
                    state.in_bracket = false;
                    i += 1;
                }
            } else {
                i += 1;
            }
            continue;
        }

        if c == '-' && chars.get(i + 1) == Some(&'-') {
            break;
        }
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            state.in_block_comment = true;
            i += 2;
            continue;
        }
        match c {
            '\'' => state.in_single = true,
            '"' => state.in_double = true,
            '[' => state.in_bracket = true,
            _ => {}
        }
        i += 1;
    }
}

fn split_sqlserver_batches(sql: &str) -> Vec<String> {
    let mut batches = Vec::new();
    let mut current = String::new();
    let mut state = SqlServerBatchParseState::default();

    for line in sql.split_inclusive('\n') {
        let can_split =
            !state.in_single && !state.in_double && !state.in_bracket && !state.in_block_comment;
        if can_split {
            if let Some(repeat) = sqlserver_go_repeat_count(line.trim_end_matches(['\r', '\n'])) {
                let batch = current.trim();
                if !batch.is_empty() {
                    for _ in 0..repeat {
                        batches.push(batch.to_string());
                    }
                }
                current.clear();
                continue;
            }
        }
        update_sqlserver_batch_parse_state(line, &mut state);
        current.push_str(line);
    }

    let tail = current.trim();
    if !tail.is_empty() {
        batches.push(tail.to_string());
    }
    batches
}

fn split_import_sql_for_database_type(database_type: &str, sql_text: &str) -> Vec<String> {
    let database_type = database_type.trim();
    if database_type.eq_ignore_ascii_case("sqlserver") {
        return split_sqlserver_batches(sql_text);
    }
    if database_type.eq_ignore_ascii_case("clickhouse") {
        return split_clickhouse_import_statements(sql_text);
    }
    split_sql_statements(sql_text)
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn strip_leading_import_comments(mut sql: &str) -> &str {
    loop {
        let trimmed = sql.trim_start();
        if let Some(rest) = trimmed.strip_prefix("--") {
            match rest.find('\n') {
                Some(pos) => {
                    sql = &rest[pos + 1..];
                    continue;
                }
                None => return "",
            }
        }
        if let Some(rest) = trimmed.strip_prefix('#') {
            match rest.find('\n') {
                Some(pos) => {
                    sql = &rest[pos + 1..];
                    continue;
                }
                None => return "",
            }
        }
        if let Some(rest) = trimmed.strip_prefix("/*") {
            match rest.find("*/") {
                Some(pos) => {
                    sql = &rest[pos + 2..];
                    continue;
                }
                None => return "",
            }
        }
        return trimmed;
    }
}

fn clickhouse_insert_uses_format_payload(stmt: &str) -> bool {
    let stripped = strip_leading_import_comments(stmt);
    if !stripped
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .eq_ignore_ascii_case("INSERT")
    {
        return false;
    }

    let tokens = stripped
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|token| !token.is_empty())
        .map(|token| token.to_ascii_uppercase())
        .collect::<Vec<_>>();
    tokens.iter().any(|token| token == "FORMAT")
}

fn semicolon_is_line_terminator(chars: &[char], pos: usize) -> bool {
    let mut i = pos;
    while i > 0 {
        let c = chars[i - 1];
        if c == '\n' || c == '\r' {
            break;
        }
        if !c.is_whitespace() {
            return false;
        }
        i -= 1;
    }

    let mut j = pos + 1;
    while j < chars.len() {
        let c = chars[j];
        if c == '\n' || c == '\r' {
            return true;
        }
        if !c.is_whitespace() {
            return false;
        }
        j += 1;
    }
    true
}

fn split_clickhouse_import_statements(sql: &str) -> Vec<String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let chars = trimmed.chars().collect::<Vec<_>>();
    let mut result = Vec::new();
    let mut current = String::new();
    let mut i = 0usize;
    let mut in_single = false;
    let mut in_double = false;
    let mut in_backtick = false;
    let mut dollar_quote_tag: Option<String> = None;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut escaped = false;

    while i < chars.len() {
        let c = chars[i];
        if let Some(tag) = dollar_quote_tag.as_ref() {
            if starts_with_chars(&chars, i, tag) {
                current.push_str(tag);
                i += tag.chars().count();
                dollar_quote_tag = None;
            } else {
                current.push(c);
                i += 1;
            }
            continue;
        }
        if in_line_comment {
            current.push(c);
            if c == '\n' {
                in_line_comment = false;
            }
            i += 1;
            continue;
        }
        if in_block_comment {
            if c == '*' && chars.get(i + 1) == Some(&'/') {
                current.push('*');
                current.push('/');
                in_block_comment = false;
                i += 2;
            } else {
                current.push(c);
                i += 1;
            }
            continue;
        }
        if escaped {
            current.push(c);
            escaped = false;
            i += 1;
            continue;
        }
        if c == '\\' && (in_single || in_double) {
            escaped = true;
            current.push(c);
            i += 1;
            continue;
        }
        if !in_single && !in_double && !in_backtick {
            if c == '-' && chars.get(i + 1) == Some(&'-') {
                current.push('-');
                current.push('-');
                in_line_comment = true;
                i += 2;
                continue;
            }
            if c == '#' {
                current.push(c);
                in_line_comment = true;
                i += 1;
                continue;
            }
            if c == '/' && chars.get(i + 1) == Some(&'*') {
                current.push('/');
                current.push('*');
                in_block_comment = true;
                i += 2;
                continue;
            }
            if c == '\'' {
                in_single = true;
                current.push(c);
                i += 1;
                continue;
            }
            if c == '"' {
                in_double = true;
                current.push(c);
                i += 1;
                continue;
            }
            if c == '`' {
                in_backtick = true;
                current.push(c);
                i += 1;
                continue;
            }
            if c == '$' {
                if let Some(tag) = read_pg_dollar_quote_tag(&chars, i) {
                    current.push_str(&tag);
                    i += tag.chars().count();
                    dollar_quote_tag = Some(tag);
                    continue;
                }
            }
            if c == ';' {
                let stmt = current.trim();
                if clickhouse_insert_uses_format_payload(stmt)
                    && !semicolon_is_line_terminator(&chars, i)
                {
                    current.push(c);
                    i += 1;
                    continue;
                }
                if !stmt.is_empty() {
                    result.push(stmt.to_string());
                }
                current.clear();
                i += 1;
                continue;
            }
        } else {
            if c == '\'' && in_single {
                in_single = false;
            }
            if c == '"' && in_double {
                in_double = false;
            }
            if c == '`' && in_backtick {
                in_backtick = false;
            }
        }
        current.push(c);
        i += 1;
    }

    let last = current.trim();
    if !last.is_empty() {
        result.push(last.to_string());
    }
    result
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

fn sqlserver_nstr(value: &str) -> String {
    format!("N{}", sqlserver_str(value))
}

fn sqlserver_base_type(data_type: &str) -> String {
    data_type
        .split_once('(')
        .map(|(base, _)| base)
        .unwrap_or(data_type)
        .trim()
        .to_ascii_lowercase()
}

fn sqlserver_quoted_literal_expr(column_sql: &str, convert_expr: &str) -> String {
    format!(
        "CASE WHEN {column_sql} IS NULL THEN N'NULL' ELSE CONCAT(N'N''', REPLACE({convert_expr}, N'''', N''''''), N'''') END"
    )
}

fn sqlserver_insert_literal_expr(column_sql: &str, data_type: &str) -> String {
    let base = sqlserver_base_type(data_type);
    match base.as_str() {
        "binary" | "varbinary" | "image" | "timestamp" | "rowversion" => format!(
            "CASE WHEN {column_sql} IS NULL THEN N'NULL' ELSE CONVERT(nvarchar(max), sys.fn_varbintohexstr(CONVERT(varbinary(max), {column_sql}))) END"
        ),
        "date" => sqlserver_quoted_literal_expr(
            column_sql,
            &format!("CONVERT(nvarchar(max), {column_sql}, 23)"),
        ),
        "time" => sqlserver_quoted_literal_expr(
            column_sql,
            &format!("CONVERT(nvarchar(max), {column_sql}, 114)"),
        ),
        "datetime" | "datetime2" | "datetimeoffset" | "smalldatetime" => {
            sqlserver_quoted_literal_expr(
                column_sql,
                &format!("CONVERT(nvarchar(max), {column_sql}, 126)"),
            )
        }
        "char" | "varchar" | "text" | "nchar" | "nvarchar" | "ntext" | "xml"
        | "uniqueidentifier" => {
            sqlserver_quoted_literal_expr(column_sql, &format!("CONVERT(nvarchar(max), {column_sql})"))
        }
        "real" | "float" => format!(
            "CASE WHEN {column_sql} IS NULL THEN N'NULL' ELSE CONVERT(nvarchar(max), {column_sql}, 2) END"
        ),
        _ => format!(
            "CASE WHEN {column_sql} IS NULL THEN N'NULL' ELSE CONVERT(nvarchar(max), {column_sql}) END"
        ),
    }
}

fn sqlserver_column_definition(col: &SqlServerColumnMeta) -> String {
    if let Some(expr) = col
        .computed_expr
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let mut line = format!("  {} AS {}", sqlserver_id(&col.name), expr);
        if col.computed_persisted {
            line.push_str(" PERSISTED");
        }
        return line;
    }

    let mut parts = vec![format!("  {} {}", sqlserver_id(&col.name), col.data_type)];
    if col.is_identity {
        let seed = col.identity_seed.as_deref().unwrap_or("1");
        let increment = col.identity_increment.as_deref().unwrap_or("1");
        parts.push(format!("IDENTITY({},{})", seed, increment));
    }
    parts.push(if col.nullable { "NULL" } else { "NOT NULL" }.to_string());
    if let Some(default_expr) = col
        .default_expr
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some(name) = col
            .default_constraint
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            parts.push(format!(
                "CONSTRAINT {} DEFAULT {}",
                sqlserver_id(name),
                default_expr
            ));
        } else {
            parts.push(format!("DEFAULT {}", default_expr));
        }
    }
    parts.join(" ")
}

fn build_sqlserver_table_ddl(
    schema: &str,
    table: &str,
    columns: &[SqlServerColumnMeta],
    primary_key: Option<&SqlServerPrimaryKeyMeta>,
) -> String {
    let mut lines = columns
        .iter()
        .map(sqlserver_column_definition)
        .collect::<Vec<_>>();
    if let Some(pk) = primary_key {
        if !pk.columns.is_empty() {
            let columns = pk
                .columns
                .iter()
                .map(|(name, desc)| {
                    format!(
                        "{} {}",
                        sqlserver_id(name),
                        if *desc { "DESC" } else { "ASC" }
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            lines.push(format!(
                "  CONSTRAINT {} PRIMARY KEY ({})",
                sqlserver_id(&pk.name),
                columns
            ));
        }
    }
    format!(
        "CREATE TABLE {}.{} (\n{}\n)",
        sqlserver_id(schema),
        sqlserver_id(table),
        lines.join(",\n")
    )
}

fn build_sqlserver_index_ddl(schema: &str, index: &SqlServerIndexMeta) -> Option<String> {
    if index.key_columns.is_empty() {
        return None;
    }
    let index_type = match index.index_type.to_ascii_uppercase().as_str() {
        "CLUSTERED" => "CLUSTERED",
        "NONCLUSTERED" => "NONCLUSTERED",
        _ => "NONCLUSTERED",
    };
    let keys = index
        .key_columns
        .iter()
        .map(|(name, desc)| {
            format!(
                "{} {}",
                sqlserver_id(name),
                if *desc { "DESC" } else { "ASC" }
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let include = if index.included_columns.is_empty() {
        String::new()
    } else {
        format!(
            " INCLUDE ({})",
            index
                .included_columns
                .iter()
                .map(|name| sqlserver_id(name))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let filter = index
        .filter_definition
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!(" WHERE {}", s))
        .unwrap_or_default();
    Some(format!(
        "CREATE {}{} INDEX {} ON {}.{} ({}){}{}",
        if index.unique { "UNIQUE " } else { "" },
        index_type,
        sqlserver_id(&index.index_name),
        sqlserver_id(schema),
        sqlserver_id(&index.table_name),
        keys,
        include,
        filter
    ))
}

fn sqlserver_referential_action(action: &str) -> Option<String> {
    let normalized = action.trim().replace('_', " ").to_ascii_uppercase();
    (!normalized.is_empty() && normalized != "NO ACTION").then_some(normalized)
}

fn build_sqlserver_foreign_key_ddl(schema: &str, fk: &SqlServerForeignKeyMeta) -> String {
    let columns = fk
        .columns
        .iter()
        .map(|(column, _)| sqlserver_id(column))
        .collect::<Vec<_>>()
        .join(", ");
    let ref_columns = fk
        .columns
        .iter()
        .map(|(_, column)| sqlserver_id(column))
        .collect::<Vec<_>>()
        .join(", ");
    let mut sql = format!(
        "ALTER TABLE {}.{} WITH CHECK ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{} ({})",
        sqlserver_id(schema),
        sqlserver_id(&fk.table_name),
        sqlserver_id(&fk.name),
        columns,
        sqlserver_id(&fk.referenced_schema),
        sqlserver_id(&fk.referenced_table),
        ref_columns
    );
    if let Some(action) = sqlserver_referential_action(&fk.delete_action) {
        sql.push_str(&format!(" ON DELETE {}", action));
    }
    if let Some(action) = sqlserver_referential_action(&fk.update_action) {
        sql.push_str(&format!(" ON UPDATE {}", action));
    }
    sql
}

fn append_sqlserver_batch(out: &mut String, ddl: &str) {
    let trimmed = ddl.trim();
    if trimmed.is_empty() {
        return;
    }
    out.push_str(&ensure_semicolon(trimmed));
    out.push('\n');
    out.push_str("GO\n");
}

fn build_sqlserver_export_script(
    metadata: &SqlServerExportMetadata,
    inserts: &[SqlServerExportInsertBatch],
) -> Result<String, String> {
    if metadata.schema.trim().is_empty() {
        return Err("schema 名称不能为空".to_string());
    }

    let mut out = String::new();
    out.push_str("-- Exported by DB Connect\n");
    out.push_str("-- Source database type: SQL Server\n");
    out.push_str(
        "-- Import: run in the target database; schema-qualified objects are preserved\n\n",
    );
    out.push_str(&format!(
        "IF SCHEMA_ID({}) IS NULL EXEC({});\nGO\n\n",
        sqlserver_nstr(&metadata.schema),
        sqlserver_nstr(&format!("CREATE SCHEMA {}", sqlserver_id(&metadata.schema)))
    ));

    if !metadata.tables.is_empty() {
        out.push_str("/* Tables */\n");
        for table in &metadata.tables {
            out.push_str(&format!("/* table {} */\n", sqlserver_id(&table.name)));
            append_sqlserver_batch(&mut out, &table.ddl);
            out.push('\n');
        }
    }

    if !metadata.routines.is_empty() {
        out.push_str("/* Functions and procedures */\n");
        for routine in &metadata.routines {
            out.push_str(&format!("/* routine {} */\n", routine.name));
            append_sqlserver_batch(&mut out, &routine.ddl);
        }
        out.push('\n');
    }

    if !inserts.is_empty() {
        out.push_str("/* Data */\n");
        for batch in inserts {
            if batch.rows.is_empty() || batch.columns.is_empty() {
                continue;
            }
            let table_ref = format!(
                "{}.{}",
                sqlserver_id(&metadata.schema),
                sqlserver_id(&batch.table)
            );
            let has_identity = batch.columns.iter().any(|column| column.is_identity);
            if has_identity {
                out.push_str(&format!("SET IDENTITY_INSERT {} ON;\n", table_ref));
            }
            let cols = batch
                .columns
                .iter()
                .map(|column| sqlserver_id(&column.name))
                .collect::<Vec<_>>()
                .join(", ");
            for rows in batch.rows.chunks(EXPORT_INSERT_BATCH) {
                let values = rows
                    .iter()
                    .map(|row| format!("({})", row.join(", ")))
                    .collect::<Vec<_>>()
                    .join(", ");
                out.push_str(&format!(
                    "INSERT INTO {} ({}) VALUES {};\n",
                    table_ref, cols, values
                ));
            }
            if has_identity {
                out.push_str(&format!("SET IDENTITY_INSERT {} OFF;\n", table_ref));
            }
            out.push_str("GO\n\n");
        }
    }

    if !metadata.views.is_empty() {
        out.push_str("/* Views */\n");
        for view in &metadata.views {
            out.push_str(&format!("/* view {} */\n", sqlserver_id(&view.name)));
            append_sqlserver_batch(&mut out, &view.ddl);
            out.push('\n');
        }
    }

    if !metadata.indexes.is_empty() {
        out.push_str("/* Indexes */\n");
        for idx in &metadata.indexes {
            out.push_str(&format!("/* index {} */\n", sqlserver_id(&idx.name)));
            append_sqlserver_batch(&mut out, &idx.ddl);
        }
        out.push('\n');
    }

    if !metadata.foreign_keys.is_empty() {
        out.push_str("/* Foreign keys */\n");
        for fk in &metadata.foreign_keys {
            out.push_str(&format!("/* foreign key {} */\n", sqlserver_id(&fk.name)));
            append_sqlserver_batch(&mut out, &fk.ddl);
        }
        out.push('\n');
    }

    if !metadata.triggers.is_empty() {
        out.push_str("/* Triggers */\n");
        for trigger in &metadata.triggers {
            out.push_str(&format!("/* trigger {} */\n", sqlserver_id(&trigger.name)));
            append_sqlserver_batch(&mut out, &trigger.ddl);
        }
        out.push('\n');
    }

    Ok(out)
}

fn sqlserver_row_string(row: &tiberius::Row, column: &str) -> String {
    row.get::<&str, _>(column)
        .map(str::to_string)
        .unwrap_or_default()
}

fn sqlserver_row_opt_string(row: &tiberius::Row, column: &str) -> Option<String> {
    row.get::<&str, _>(column)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

async fn query_sqlserver_rows(
    pool: &sqlserver::SqlServerPool,
    action: &str,
    sql: String,
) -> Result<Vec<tiberius::Row>, String> {
    let mut client = pool
        .get()
        .await
        .map_err(|e| sqlserver::normalize_sqlserver_error("获取连接失败", e.to_string()))?;
    let rows = client
        .simple_query(sql)
        .await
        .map_err(|e| sqlserver::normalize_sqlserver_error(action, e.to_string()))?
        .into_first_result()
        .await
        .map_err(|e| sqlserver::normalize_sqlserver_error(action, e.to_string()))?;
    Ok(rows)
}

async fn load_sqlserver_export_metadata(
    pool: &sqlserver::SqlServerPool,
    schema: &str,
) -> Result<SqlServerExportMetadata, String> {
    let schema_lit = sqlserver_nstr(schema);
    let relation_rows = query_sqlserver_rows(
        pool,
        "查询 SQL Server 表/视图",
        format!(
            "SELECT CAST(o.object_id AS int) AS object_id, o.name, o.type AS object_type, \
                    m.definition \
             FROM sys.objects o \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             LEFT JOIN sys.sql_modules m ON m.object_id = o.object_id \
             WHERE s.name = {schema_lit} AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0 \
             ORDER BY CASE WHEN o.type = 'U' THEN 0 ELSE 1 END, o.name"
        ),
    )
    .await?;

    let relations = relation_rows
        .iter()
        .map(|row| {
            (
                row.get::<i32, _>("object_id").unwrap_or(0),
                sqlserver_row_string(row, "name"),
                sqlserver_row_string(row, "object_type"),
                sqlserver_row_opt_string(row, "definition"),
            )
        })
        .filter(|(object_id, name, _, _)| *object_id != 0 && !name.is_empty())
        .collect::<Vec<_>>();

    let column_rows = query_sqlserver_rows(
        pool,
        "查询 SQL Server 列",
        format!(
            "SELECT CAST(t.object_id AS int) AS object_id, c.name AS column_name, \
                    ty.name AS type_name, CAST(c.max_length AS int) AS max_length, \
                    CAST(c.precision AS int) AS precision_value, CAST(c.scale AS int) AS scale_value, \
                    CAST(c.is_nullable AS bit) AS is_nullable, CAST(c.is_identity AS bit) AS is_identity, \
                    CAST(c.is_computed AS bit) AS is_computed, \
                    CONVERT(nvarchar(100), ident.seed_value) AS identity_seed, \
                    CONVERT(nvarchar(100), ident.increment_value) AS identity_increment, \
                    dc.name AS default_constraint, dc.definition AS default_definition, \
                    comp.definition AS computed_definition, \
                    CAST(COALESCE(comp.is_persisted, 0) AS bit) AS computed_persisted, \
                    CAST(ty.is_user_defined AS bit) AS is_user_defined \
             FROM sys.tables t \
             JOIN sys.schemas s ON s.schema_id = t.schema_id \
             JOIN sys.columns c ON c.object_id = t.object_id \
             JOIN sys.types ty ON ty.user_type_id = c.user_type_id \
             LEFT JOIN sys.identity_columns ident ON ident.object_id = c.object_id AND ident.column_id = c.column_id \
             LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id \
             LEFT JOIN sys.computed_columns comp ON comp.object_id = c.object_id AND comp.column_id = c.column_id \
             WHERE s.name = {schema_lit} AND t.is_ms_shipped = 0 \
             ORDER BY t.name, c.column_id"
        ),
    )
    .await?;

    let mut columns_by_object: BTreeMap<i32, Vec<SqlServerColumnMeta>> = BTreeMap::new();
    for row in &column_rows {
        let object_id = row.get::<i32, _>("object_id").unwrap_or(0);
        if object_id == 0 {
            continue;
        }
        let type_name = sqlserver_row_string(row, "type_name");
        let data_type = sqlserver::format_sqlserver_column_type(
            &type_name,
            row.get::<i32, _>("max_length"),
            row.get::<i32, _>("precision_value"),
            row.get::<i32, _>("scale_value"),
            row.get::<bool, _>("is_user_defined").unwrap_or(false),
        );
        columns_by_object
            .entry(object_id)
            .or_default()
            .push(SqlServerColumnMeta {
                name: sqlserver_row_string(row, "column_name"),
                data_type,
                nullable: row.get::<bool, _>("is_nullable").unwrap_or(false),
                default_constraint: sqlserver_row_opt_string(row, "default_constraint"),
                default_expr: sqlserver_row_opt_string(row, "default_definition"),
                is_identity: row.get::<bool, _>("is_identity").unwrap_or(false),
                identity_seed: sqlserver_row_opt_string(row, "identity_seed"),
                identity_increment: sqlserver_row_opt_string(row, "identity_increment"),
                computed_expr: sqlserver_row_opt_string(row, "computed_definition"),
                computed_persisted: row.get::<bool, _>("computed_persisted").unwrap_or(false),
            });
    }

    let primary_key_rows = query_sqlserver_rows(
        pool,
        "查询 SQL Server 主键",
        format!(
            "SELECT CAST(t.object_id AS int) AS object_id, kc.name AS constraint_name, \
                    c.name AS column_name, CAST(ic.is_descending_key AS bit) AS is_descending_key, \
                    CAST(ic.key_ordinal AS int) AS key_ordinal \
             FROM sys.key_constraints kc \
             JOIN sys.tables t ON t.object_id = kc.parent_object_id \
             JOIN sys.schemas s ON s.schema_id = t.schema_id \
             JOIN sys.index_columns ic ON ic.object_id = t.object_id AND ic.index_id = kc.unique_index_id \
             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
             WHERE s.name = {schema_lit} AND kc.type = 'PK' \
             ORDER BY t.name, ic.key_ordinal"
        ),
    )
    .await?;

    let mut primary_keys: BTreeMap<i32, SqlServerPrimaryKeyMeta> = BTreeMap::new();
    for row in &primary_key_rows {
        let object_id = row.get::<i32, _>("object_id").unwrap_or(0);
        if object_id == 0 {
            continue;
        }
        primary_keys
            .entry(object_id)
            .or_insert_with(|| SqlServerPrimaryKeyMeta {
                name: sqlserver_row_string(row, "constraint_name"),
                columns: Vec::new(),
            })
            .columns
            .push((
                sqlserver_row_string(row, "column_name"),
                row.get::<bool, _>("is_descending_key").unwrap_or(false),
            ));
    }

    let mut tables = Vec::new();
    let mut views = Vec::new();
    for (object_id, name, object_type, definition) in &relations {
        if object_type == "U" {
            let columns = columns_by_object.remove(object_id).unwrap_or_default();
            let data_columns = columns
                .iter()
                .filter(|column| column.computed_expr.is_none())
                .map(|column| SqlServerExportDataColumn {
                    name: column.name.clone(),
                    data_type: column.data_type.clone(),
                    is_identity: column.is_identity,
                })
                .collect::<Vec<_>>();
            let ddl =
                build_sqlserver_table_ddl(schema, name, &columns, primary_keys.get(object_id));
            tables.push(SqlServerExportRelation {
                name: name.clone(),
                ddl,
                columns: data_columns,
            });
        } else if let Some(ddl) = definition.as_ref().filter(|ddl| !ddl.trim().is_empty()) {
            views.push(SqlServerExportObject {
                name: name.clone(),
                ddl: ddl.clone(),
            });
        }
    }

    let index_rows = query_sqlserver_rows(
        pool,
        "查询 SQL Server 索引",
        format!(
            "SELECT t.name AS table_name, i.name AS index_name, CAST(i.is_unique AS bit) AS is_unique, \
                    i.type_desc AS index_type, i.filter_definition, c.name AS column_name, \
                    CAST(COALESCE(ic.key_ordinal, 0) AS int) AS key_ordinal, \
                    CAST(COALESCE(ic.is_descending_key, 0) AS bit) AS is_descending_key, \
                    CAST(COALESCE(ic.is_included_column, 0) AS bit) AS is_included_column, \
                    CAST(COALESCE(ic.index_column_id, 0) AS int) AS index_column_id \
             FROM sys.indexes i \
             JOIN sys.tables t ON t.object_id = i.object_id \
             JOIN sys.schemas s ON s.schema_id = t.schema_id \
             LEFT JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             LEFT JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
             WHERE s.name = {schema_lit} AND i.index_id > 0 AND i.type IN (1, 2) \
               AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.is_hypothetical = 0 \
             ORDER BY t.name, i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id"
        ),
    )
    .await?;

    let mut indexes_by_name: BTreeMap<(String, String), SqlServerIndexMeta> = BTreeMap::new();
    for row in &index_rows {
        let table_name = sqlserver_row_string(row, "table_name");
        let index_name = sqlserver_row_string(row, "index_name");
        if table_name.is_empty() || index_name.is_empty() {
            continue;
        }
        let column_name = sqlserver_row_string(row, "column_name");
        let entry = indexes_by_name
            .entry((table_name.clone(), index_name.clone()))
            .or_insert_with(|| SqlServerIndexMeta {
                table_name: table_name.clone(),
                index_name: index_name.clone(),
                unique: row.get::<bool, _>("is_unique").unwrap_or(false),
                index_type: sqlserver_row_string(row, "index_type"),
                filter_definition: sqlserver_row_opt_string(row, "filter_definition"),
                key_columns: Vec::new(),
                included_columns: Vec::new(),
            });
        if column_name.is_empty() {
            continue;
        }
        if row.get::<bool, _>("is_included_column").unwrap_or(false) {
            entry.included_columns.push(column_name);
        } else if row.get::<i32, _>("key_ordinal").unwrap_or(0) > 0 {
            entry.key_columns.push((
                column_name,
                row.get::<bool, _>("is_descending_key").unwrap_or(false),
            ));
        }
    }
    let indexes = indexes_by_name
        .values()
        .filter_map(|index| {
            build_sqlserver_index_ddl(schema, index).map(|ddl| SqlServerExportObject {
                name: index.index_name.clone(),
                ddl,
            })
        })
        .collect::<Vec<_>>();

    let fk_rows = query_sqlserver_rows(
        pool,
        "查询 SQL Server 外键",
        format!(
            "SELECT fk.name AS fk_name, t.name AS table_name, rs.name AS referenced_schema, \
                    rt.name AS referenced_table, fk.delete_referential_action_desc AS delete_action, \
                    fk.update_referential_action_desc AS update_action, pc.name AS column_name, \
                    rc.name AS referenced_column, CAST(fkc.constraint_column_id AS int) AS ordinal \
             FROM sys.foreign_keys fk \
             JOIN sys.tables t ON t.object_id = fk.parent_object_id \
             JOIN sys.schemas s ON s.schema_id = t.schema_id \
             JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id \
             JOIN sys.schemas rs ON rs.schema_id = rt.schema_id \
             JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
             JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
             JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
             WHERE s.name = {schema_lit} \
             ORDER BY t.name, fk.name, fkc.constraint_column_id"
        ),
    )
    .await?;

    let mut fks_by_name: BTreeMap<(String, String), SqlServerForeignKeyMeta> = BTreeMap::new();
    for row in &fk_rows {
        let table_name = sqlserver_row_string(row, "table_name");
        let name = sqlserver_row_string(row, "fk_name");
        if table_name.is_empty() || name.is_empty() {
            continue;
        }
        fks_by_name
            .entry((table_name.clone(), name.clone()))
            .or_insert_with(|| SqlServerForeignKeyMeta {
                name: name.clone(),
                table_name: table_name.clone(),
                referenced_schema: sqlserver_row_string(row, "referenced_schema"),
                referenced_table: sqlserver_row_string(row, "referenced_table"),
                delete_action: sqlserver_row_string(row, "delete_action"),
                update_action: sqlserver_row_string(row, "update_action"),
                columns: Vec::new(),
            })
            .columns
            .push((
                sqlserver_row_string(row, "column_name"),
                sqlserver_row_string(row, "referenced_column"),
            ));
    }
    let foreign_keys = fks_by_name
        .values()
        .map(|fk| SqlServerExportObject {
            name: fk.name.clone(),
            ddl: build_sqlserver_foreign_key_ddl(schema, fk),
        })
        .collect::<Vec<_>>();

    let trigger_rows = query_sqlserver_rows(
        pool,
        "查询 SQL Server 触发器",
        format!(
            "SELECT tr.name, m.definition \
             FROM sys.triggers tr \
             JOIN sys.tables t ON t.object_id = tr.parent_id \
             JOIN sys.schemas s ON s.schema_id = t.schema_id \
             JOIN sys.sql_modules m ON m.object_id = tr.object_id \
             WHERE s.name = {schema_lit} AND tr.is_ms_shipped = 0 \
             ORDER BY t.name, tr.name"
        ),
    )
    .await?;
    let triggers = trigger_rows
        .iter()
        .filter_map(|row| {
            let ddl = sqlserver_row_opt_string(row, "definition")?;
            Some(SqlServerExportObject {
                name: sqlserver_row_string(row, "name"),
                ddl,
            })
        })
        .collect::<Vec<_>>();

    let routine_rows = query_sqlserver_rows(
        pool,
        "查询 SQL Server 函数/过程",
        format!(
            "SELECT o.name, m.definition \
             FROM sys.objects o \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             JOIN sys.sql_modules m ON m.object_id = o.object_id \
             WHERE s.name = {schema_lit} AND o.type IN ('P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT') \
             ORDER BY o.type, o.name"
        ),
    )
    .await?;
    let routines = routine_rows
        .iter()
        .filter_map(|row| {
            let ddl = sqlserver_row_opt_string(row, "definition")?;
            Some(SqlServerExportObject {
                name: sqlserver_row_string(row, "name"),
                ddl,
            })
        })
        .collect::<Vec<_>>();

    Ok(SqlServerExportMetadata {
        schema: schema.to_string(),
        tables,
        views,
        indexes,
        foreign_keys,
        triggers,
        routines,
    })
}

fn build_sqlserver_insert_batch_query(
    schema: &str,
    tables: &[SqlServerExportRelation],
    max_rows: u64,
) -> Option<String> {
    let parts = tables
        .iter()
        .enumerate()
        .filter(|(_, table)| !table.columns.is_empty())
        .map(|(idx, table)| {
            let literal_expr = table
                .columns
                .iter()
                .map(|column| {
                    sqlserver_insert_literal_expr(&sqlserver_id(&column.name), &column.data_type)
                })
                .collect::<Vec<_>>()
                .join(" + N', ' + ");
            let select_cols = table
                .columns
                .iter()
                .map(|column| sqlserver_id(&column.name))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "(SELECT {idx} AS table_order, {} AS table_name, {} AS values_sql \
                  FROM (SELECT TOP ({}) {} FROM {}.{}) AS exported_rows)",
                sqlserver_nstr(&table.name),
                literal_expr,
                max_rows,
                select_cols,
                sqlserver_id(schema),
                sqlserver_id(&table.name)
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

async fn load_sqlserver_insert_batches(
    pool: &sqlserver::SqlServerPool,
    schema: &str,
    tables: &[SqlServerExportRelation],
    max_rows: u64,
) -> Result<(Vec<SqlServerExportInsertBatch>, u64), String> {
    let Some(sql) = build_sqlserver_insert_batch_query(schema, tables, max_rows) else {
        return Ok((Vec::new(), 0));
    };
    let rows = query_sqlserver_rows(pool, "导出 SQL Server 表数据", sql).await?;
    let mut insert_rows = 0u64;
    let mut rows_by_table: BTreeMap<String, Vec<Vec<String>>> = BTreeMap::new();
    for row in &rows {
        let table_name = sqlserver_row_string(row, "table_name");
        let values_sql = sqlserver_row_string(row, "values_sql");
        if table_name.is_empty() || values_sql.is_empty() {
            continue;
        }
        insert_rows += 1;
        rows_by_table
            .entry(table_name)
            .or_default()
            .push(vec![values_sql]);
    }

    let batches = tables
        .iter()
        .filter_map(|table| {
            rows_by_table
                .remove(&table.name)
                .map(|rows| SqlServerExportInsertBatch {
                    table: table.name.clone(),
                    columns: table.columns.clone(),
                    rows,
                })
        })
        .collect();

    Ok((batches, insert_rows))
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

async fn read_sql_file_text(file_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let path = Path::new(&file_path);
        let meta =
            std::fs::metadata(path).map_err(|e| format_fs_err("无法读取 SQL 文件信息", e))?;
        let file_len = meta.len();
        if file_len > MAX_IMPORT_FILE_BYTES {
            let cur_mb = file_len as f64 / (1024.0 * 1024.0);
            let max_mb = MAX_IMPORT_FILE_BYTES / (1024 * 1024);
            return Err(format!(
                "SQL 文件过大（当前约 {:.1} MB，单文件上限 {} MB）。可将文件拆分后分批导入，或使用数据库客户端导入。",
                cur_mb, max_mb
            ));
        }
        let bytes = std::fs::read(path).map_err(|e| format_fs_err("读取 SQL 文件失败", e))?;
        let bytes = strip_utf8_bom(&bytes);
        let text = std::str::from_utf8(bytes).map_err(|_| "文件不是有效 UTF-8 文本".to_string())?;
        Ok(text.to_string())
    })
    .await
    .map_err(|e| format!("读取 SQL 文件任务失败: {}", e))?
}

fn is_dangerous_import_statement(stmt: &str) -> bool {
    let upper = stmt.trim().to_uppercase();
    upper.starts_with("TRUNCATE")
        || upper.starts_with("DROP DATABASE")
        || upper.starts_with("DROP SCHEMA")
}

fn preview_sql_file_dangerous_statements(
    database_type: &str,
    sql_text: &str,
) -> PreviewSqlFileImportResult {
    let statements = split_import_sql_for_database_type(database_type, sql_text);
    let mut dangerous_statements = Vec::new();
    let mut dangerous_statements_total = 0u32;

    for (idx, stmt) in statements.iter().enumerate() {
        if !is_dangerous_import_statement(stmt) {
            continue;
        }
        dangerous_statements_total += 1;
        if dangerous_statements.len() < MAX_RECORDED_IMPORT_FAILURES {
            dangerous_statements.push(DangerousSqlStatementPreview {
                statement_index: (idx + 1) as u32,
                statement_preview: summarize_import_statement(stmt),
            });
        }
    }

    PreviewSqlFileImportResult {
        statements_total: statements.len() as u32,
        dangerous_statements_total,
        dangerous_statements,
    }
}

#[tauri::command]
pub async fn preview_sql_file_import(
    database_type: Option<String>,
    file_path: String,
) -> Result<PreviewSqlFileImportResult, String> {
    let sql_text = read_sql_file_text(file_path).await?;
    Ok(preview_sql_file_dangerous_statements(
        database_type.as_deref().unwrap_or("mysql"),
        &sql_text,
    ))
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

    // 读取整文件（上限 512MB）是阻塞型 IO，放到 blocking 线程池，
    // 避免阻塞当前 Tokio worker 线程影响其它异步命令。拆分需按数据库类型选择。
    let sql_text = read_sql_file_text(file_path.clone()).await?;

    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let statements: Vec<String> = match &pool_handle {
        DatabasePoolHandle::SqlServer(_) => {
            split_import_sql_for_database_type("sqlserver", &sql_text)
        }
        DatabasePoolHandle::ClickHouse(_) => {
            split_import_sql_for_database_type("clickhouse", &sql_text)
        }
        _ => split_import_sql_for_database_type("mysql", &sql_text),
    };
    let total = statements.len() as u32;
    if total == 0 {
        return Err("未解析到任何 SQL 语句".to_string());
    }

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
        DatabasePoolHandle::Sqlite(handle) => {
            let conn = handle
                .pool
                .get()
                .await
                .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
            for (i, stmt) in statements.iter().enumerate() {
                match sqlite::run_one_statement(&conn, stmt).await {
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
        DatabasePoolHandle::SqlServer(handle) => {
            let mut client =
                handle.pool.get().await.map_err(|e| {
                    sqlserver::normalize_sqlserver_error("获取连接失败", e.to_string())
                })?;

            for (i, stmt) in statements.iter().enumerate() {
                match run_one_sqlserver_batch(&mut client, stmt).await {
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
        DatabasePoolHandle::ClickHouse(handle) => {
            let client = match database
                .as_deref()
                .map(str::trim)
                .filter(|db| !db.is_empty())
            {
                Some(db) => handle.client.as_ref().clone().with_database(db.to_string()),
                None => handle.client.as_ref().clone(),
            };

            for (i, stmt) in statements.iter().enumerate() {
                match run_one_clickhouse_statement(&client, stmt).await {
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

fn build_clickhouse_export_metadata_sql() -> &'static str {
    "SELECT name, \
            CASE WHEN engine IN ('View', 'MaterializedView', 'LiveView') \
                 THEN 'VIEW' ELSE 'TABLE' END AS object_type, \
            create_table_query \
     FROM system.tables \
     WHERE database = ? \
       AND engine != 'Dictionary' \
     ORDER BY object_type, name"
}

async fn fetch_clickhouse_json_each_rows<T>(
    query: clickhouse_rs::query::Query,
    context: &str,
) -> Result<Vec<T>, String>
where
    T: serde::de::DeserializeOwned,
{
    let mut cursor = query
        .fetch_bytes("JSONEachRow")
        .map_err(|e| format!("{}: {}", context, e))?;
    let bytes = cursor
        .collect()
        .await
        .map_err(|e| format!("{}: {}", context, e))?;
    let text = std::str::from_utf8(bytes.as_ref())
        .map_err(|e| format!("{}: ClickHouse 返回了非 UTF-8 JSONEachRow: {}", context, e))?;
    clickhouse::parse_json_each_rows(text).map_err(|e| format!("{}: {}", context, e))
}

async fn load_clickhouse_export_metadata(
    client: &clickhouse_rs::Client,
    database: &str,
) -> Result<ClickHouseExportMetadata, String> {
    let rows: Vec<ClickHouseExportTableRow> = fetch_clickhouse_json_each_rows(
        client
            .query(build_clickhouse_export_metadata_sql())
            .bind(database),
        "读取 ClickHouse 导出元数据失败",
    )
    .await?;

    let mut tables = Vec::new();
    let mut views = Vec::new();
    for row in rows {
        if row.create_table_query.trim().is_empty() {
            continue;
        }
        let relation_kind = if row.object_type.eq_ignore_ascii_case("VIEW") {
            ClickHouseExportRelationKind::View
        } else {
            ClickHouseExportRelationKind::Table
        };
        let relation = ClickHouseExportRelation {
            name: row.name,
            relation_kind: relation_kind.clone(),
            ddl: row.create_table_query,
        };
        match relation_kind {
            ClickHouseExportRelationKind::Table => tables.push(relation),
            ClickHouseExportRelationKind::View => views.push(relation),
        }
    }

    Ok(ClickHouseExportMetadata {
        database: database.to_string(),
        tables,
        views,
    })
}

fn count_clickhouse_values_rows(rows_sql: &str) -> u64 {
    let chars = rows_sql.chars().collect::<Vec<_>>();
    let mut count = 0u64;
    let mut depth = 0usize;
    let mut in_single = false;
    let mut escaped = false;
    let mut i = 0usize;

    while i < chars.len() {
        let c = chars[i];
        if in_single {
            if escaped {
                escaped = false;
                i += 1;
                continue;
            }
            if c == '\\' {
                escaped = true;
                i += 1;
                continue;
            }
            if c == '\'' {
                if chars.get(i + 1) == Some(&'\'') {
                    i += 2;
                    continue;
                }
                in_single = false;
            }
            i += 1;
            continue;
        }

        if c == '\'' {
            in_single = true;
            i += 1;
            continue;
        }
        if c == '(' {
            if depth == 0 {
                count += 1;
            }
            depth += 1;
        } else if c == ')' && depth > 0 {
            depth -= 1;
        }
        i += 1;
    }

    count
}

async fn fetch_clickhouse_values_rows(
    client: &clickhouse_rs::Client,
    sql: &str,
    context: &str,
) -> Result<String, String> {
    let mut cursor = client
        .query(sql)
        .with_setting("wait_end_of_query", "1")
        .fetch_bytes("Values")
        .map_err(|e| format!("{}: {}", context, e))?;
    let bytes = cursor
        .collect()
        .await
        .map_err(|e| format!("{}: {}", context, e))?;
    std::str::from_utf8(bytes.as_ref())
        .map(str::to_string)
        .map_err(|e| format!("{}: ClickHouse 返回了非 UTF-8 Values: {}", context, e))
}

/// 按表导出数据是用户显式选择的业务循环；元数据仍由 `system.tables` 一次性读取。
async fn load_clickhouse_export_data_blocks(
    app: &AppHandle,
    client: &clickhouse_rs::Client,
    metadata: &ClickHouseExportMetadata,
    max_rows: u64,
    progress_offset: u32,
    total_steps: u32,
    cancel_token: Option<&SqlExportCancelToken>,
) -> Result<(Vec<ClickHouseExportDataBlock>, u64), String> {
    let mut blocks = Vec::new();
    let mut insert_rows = 0u64;

    for (idx, table) in metadata.tables.iter().enumerate() {
        if let Some(token) = cancel_token {
            token.check()?;
        }
        let sql = format!(
            "SELECT * FROM {} LIMIT {}",
            clickhouse::clickhouse_table_ref(&metadata.database, &table.name),
            max_rows
        );
        let rows_sql = fetch_clickhouse_values_rows(
            client,
            &sql,
            &format!("导出 ClickHouse 表 `{}` 数据失败", table.name),
        )
        .await?;
        if let Some(token) = cancel_token {
            token.check()?;
        }
        let row_count = count_clickhouse_values_rows(&rows_sql);
        if row_count > 0 {
            insert_rows += row_count;
            blocks.push(ClickHouseExportDataBlock {
                table: table.name.clone(),
                rows_sql,
                row_count,
            });
        }
        let _ = app.emit(
            "sql-export-progress",
            SqlExportProgress {
                current: progress_offset + idx as u32 + 1,
                total: total_steps.max(1),
            },
        );
    }

    Ok((blocks, insert_rows))
}

fn push_clickhouse_relations_script(out: &mut String, relations: &[ClickHouseExportRelation]) {
    for relation in relations {
        out.push('\n');
        match relation.relation_kind {
            ClickHouseExportRelationKind::Table => {
                out.push_str(&format!("/* table `{}` */\n", relation.name));
            }
            ClickHouseExportRelationKind::View => {
                out.push_str(&format!("/* view `{}` */\n", relation.name));
            }
        }
        out.push_str(&ensure_semicolon(&relation.ddl));
        out.push('\n');
    }
}

fn build_clickhouse_export_script(
    metadata: &ClickHouseExportMetadata,
    data_blocks: &[ClickHouseExportDataBlock],
    include_data: bool,
    max_rows: u64,
) -> Result<String, String> {
    let mut out = String::new();
    out.push_str("-- DB Connect ClickHouse export\n");
    out.push_str(&format!(
        "-- Source database: {} | include_data: {} | max_rows_per_table: {}\n",
        metadata.database, include_data, max_rows
    ));
    out.push_str("-- ClickHouse 首版不导出触发器、外键、例程或事件。\n");
    out.push_str(&format!(
        "CREATE DATABASE IF NOT EXISTS {};\n",
        clickhouse::clickhouse_id(&metadata.database)
    ));
    out.push_str(&format!(
        "USE {};\n",
        clickhouse::clickhouse_id(&metadata.database)
    ));

    push_clickhouse_relations_script(&mut out, &metadata.tables);
    push_clickhouse_relations_script(&mut out, &metadata.views);

    if include_data {
        out.push_str("\n/* Data */\n");
        out.push_str(
            "-- ClickHouse data export is a per-table business loop using SELECT ... FORMAT Values; metadata is not queried in this loop.\n",
        );
        for block in data_blocks {
            if block.rows_sql.trim().is_empty() {
                continue;
            }
            out.push('\n');
            out.push_str(&format!(
                "/* `{}` rows: {} */\n",
                block.table, block.row_count
            ));
            out.push_str(&format!(
                "INSERT INTO {} FORMAT Values\n",
                clickhouse::clickhouse_table_ref(&metadata.database, &block.table)
            ));
            out.push_str(block.rows_sql.trim_end());
            out.push_str("\n;\n");
        }
    }

    Ok(out)
}

async fn export_clickhouse_database_to_file_impl(
    app: &AppHandle,
    client: &clickhouse_rs::Client,
    request: ClickHouseExportRequest<'_>,
) -> Result<ExportSqlFileResult, String> {
    let start = Instant::now();
    let ClickHouseExportRequest {
        database,
        file_path,
        include_data,
        max_rows,
        mut file,
        cancel_token,
    } = request;
    let metadata = load_clickhouse_export_metadata(client, database).await?;
    if let Some(token) = cancel_token {
        token.check()?;
    }
    let metadata_steps = metadata.tables.len() + metadata.views.len();
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

    let (data_blocks, insert_rows) = if include_data {
        load_clickhouse_export_data_blocks(
            app,
            client,
            &metadata,
            max_rows,
            metadata_steps as u32,
            total_steps_u32,
            cancel_token,
        )
        .await?
    } else {
        (Vec::new(), 0)
    };
    if let Some(token) = cancel_token {
        token.check()?;
    }

    let script = build_clickhouse_export_script(&metadata, &data_blocks, include_data, max_rows)?;
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
        triggers_exported: 0,
        events_exported: 0,
        insert_rows,
        file_path,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
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

async fn export_sqlite_database_to_file_impl(
    app: &AppHandle,
    pool: &deadpool_sqlite::Pool,
    schema: &str,
    file_path: String,
    include_data: bool,
    max_rows: u64,
    mut file: BufWriter<std::fs::File>,
) -> Result<ExportSqlFileResult, String> {
    let start = Instant::now();
    let metadata = sqlite::load_export_metadata(pool, schema).await?;
    let metadata_steps = metadata.objects.len();
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
        sqlite::load_export_insert_batches(pool, schema, &metadata.tables, max_rows).await?
    } else {
        (Vec::new(), 0)
    };
    let script = sqlite::build_export_script(&metadata, &inserts)?;
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
        tables_exported: metadata
            .objects
            .iter()
            .filter(|object| object.object_type == "table")
            .count() as u32,
        views_exported: metadata
            .objects
            .iter()
            .filter(|object| object.object_type == "view")
            .count() as u32,
        triggers_exported: metadata
            .objects
            .iter()
            .filter(|object| object.object_type == "trigger")
            .count() as u32,
        events_exported: 0,
        insert_rows,
        file_path,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

async fn export_sqlserver_database_to_file_impl(
    app: &AppHandle,
    pool: &sqlserver::SqlServerPool,
    schema: &str,
    file_path: String,
    include_data: bool,
    max_rows: u64,
    mut file: BufWriter<std::fs::File>,
) -> Result<ExportSqlFileResult, String> {
    let start = Instant::now();
    let metadata = load_sqlserver_export_metadata(pool, schema).await?;
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
        load_sqlserver_insert_batches(pool, schema, &metadata.tables, max_rows).await?
    } else {
        (Vec::new(), 0)
    };

    let script = build_sqlserver_export_script(&metadata, &inserts)?;
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

#[tauri::command]
pub async fn cancel_sql_export(
    state: State<'_, AppState>,
    export_id: String,
) -> Result<bool, String> {
    let token = {
        let exports = state.running_sql_exports.lock().await;
        exports.get(export_id.trim()).cloned()
    };

    let Some(token) = token else {
        return Ok(false);
    };

    SqlExportCancelToken::from_arc(token).cancel();
    Ok(true)
}

/// 将当前库导出为 .sql（表/视图的 CREATE；可选导出表数据为 INSERT，每表最多 `max_rows_per_table` 行）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_database_to_file(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    file_path: String,
    include_data: bool,
    max_rows_per_table: u32,
    export_id: Option<String>,
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
        DatabasePoolHandle::Sqlite(handle) => {
            return export_sqlite_database_to_file_impl(
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
        DatabasePoolHandle::SqlServer(handle) => {
            return export_sqlserver_database_to_file_impl(
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
        DatabasePoolHandle::ClickHouse(handle) => {
            let cancel_registration = export_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(|id| (id.to_string(), SqlExportCancelToken::new()));
            if let Some((id, token)) = &cancel_registration {
                state
                    .running_sql_exports
                    .lock()
                    .await
                    .insert(id.clone(), token.flag());
            }

            let result = export_clickhouse_database_to_file_impl(
                &app,
                &handle.client,
                ClickHouseExportRequest {
                    database: &database,
                    file_path,
                    include_data,
                    max_rows,
                    file,
                    cancel_token: cancel_registration.as_ref().map(|(_, token)| token),
                },
            )
            .await;

            if let Some((id, _)) = cancel_registration {
                state.running_sql_exports.lock().await.remove(&id);
            }
            return result;
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

    #[test]
    fn sqlserver_go_splitter_respects_strings_comments_and_batches() {
        let sql = "\
CREATE TABLE [dbo].[users] ([name] nvarchar(100));\n\
GO\n\
INSERT INTO [dbo].[users] ([name]) VALUES (N'GO is data');\n\
-- GO in a line comment must not split\n\
/*\n\
GO in a block comment must not split\n\
*/\n\
GO\n\
CREATE TRIGGER [dbo].[users_ai] ON [dbo].[users]\n\
AFTER INSERT AS\n\
BEGIN\n\
  PRINT N'created by trigger';\n\
END\n\
go\n";

        let batches = split_sqlserver_batches(sql);

        assert_eq!(batches.len(), 3, "{:#?}", batches);
        assert!(batches[0].contains("CREATE TABLE"));
        assert!(batches[1].contains("GO is data"));
        assert!(batches[1].contains("GO in a block comment"));
        assert!(batches[2].contains("CREATE TRIGGER"));
        assert!(!batches
            .iter()
            .any(|batch| batch.trim().eq_ignore_ascii_case("GO")));
    }

    #[test]
    fn sqlserver_export_script_includes_schema_objects_insert_data_and_go_batches() {
        let metadata = SqlServerExportMetadata {
            schema: "dbo".to_string(),
            tables: vec![SqlServerExportRelation {
                name: "users".to_string(),
                ddl: "CREATE TABLE [dbo].[users] (\n  [id] int IDENTITY(1,1) NOT NULL,\n  [name] nvarchar(100) NULL,\n  CONSTRAINT [PK_users] PRIMARY KEY ([id])\n)"
                    .to_string(),
                columns: vec![
                    SqlServerExportDataColumn {
                        name: "id".to_string(),
                        data_type: "int".to_string(),
                        is_identity: true,
                    },
                    SqlServerExportDataColumn {
                        name: "name".to_string(),
                        data_type: "nvarchar".to_string(),
                        is_identity: false,
                    },
                ],
            }],
            views: vec![SqlServerExportObject {
                name: "active_users".to_string(),
                ddl: "CREATE VIEW [dbo].[active_users] AS SELECT [id], [name] FROM [dbo].[users]"
                    .to_string(),
            }],
            indexes: vec![SqlServerExportObject {
                name: "IX_users_name".to_string(),
                ddl: "CREATE UNIQUE NONCLUSTERED INDEX [IX_users_name] ON [dbo].[users] ([name] ASC)"
                    .to_string(),
            }],
            foreign_keys: vec![SqlServerExportObject {
                name: "FK_users_org".to_string(),
                ddl: "ALTER TABLE [dbo].[users] WITH CHECK ADD CONSTRAINT [FK_users_org] FOREIGN KEY ([org_id]) REFERENCES [dbo].[orgs] ([id])"
                    .to_string(),
            }],
            triggers: vec![SqlServerExportObject {
                name: "users_ai".to_string(),
                ddl: "CREATE TRIGGER [dbo].[users_ai] ON [dbo].[users] AFTER INSERT AS BEGIN SELECT 1; END"
                    .to_string(),
            }],
            routines: vec![SqlServerExportObject {
                name: "touch_user".to_string(),
                ddl: "CREATE PROCEDURE [dbo].[touch_user] AS SELECT 1".to_string(),
            }],
        };
        let inserts = vec![SqlServerExportInsertBatch {
            table: "users".to_string(),
            columns: vec![
                SqlServerExportDataColumn {
                    name: "id".to_string(),
                    data_type: "int".to_string(),
                    is_identity: true,
                },
                SqlServerExportDataColumn {
                    name: "name".to_string(),
                    data_type: "nvarchar".to_string(),
                    is_identity: false,
                },
            ],
            rows: vec![
                vec!["1".to_string(), "N'Ada'".to_string()],
                vec!["2".to_string(), "N'Bob'".to_string()],
            ],
        }];

        let script = build_sqlserver_export_script(&metadata, &inserts).unwrap();

        assert!(script.contains("IF SCHEMA_ID(N'dbo') IS NULL EXEC(N'CREATE SCHEMA [dbo]');"));
        assert!(script.contains("CREATE TABLE [dbo].[users]"));
        assert!(script.contains("CREATE PROCEDURE [dbo].[touch_user]"));
        assert!(script.contains("CREATE VIEW [dbo].[active_users]"));
        assert!(script.contains("CREATE UNIQUE NONCLUSTERED INDEX [IX_users_name]"));
        assert!(script.contains("ADD CONSTRAINT [FK_users_org]"));
        assert!(script.contains("CREATE TRIGGER [dbo].[users_ai]"));
        assert!(script.contains("SET IDENTITY_INSERT [dbo].[users] ON;"));
        assert!(script
            .contains("INSERT INTO [dbo].[users] ([id], [name]) VALUES (1, N'Ada'), (2, N'Bob');"));
        assert!(script.contains("SET IDENTITY_INSERT [dbo].[users] OFF;"));
        assert!(script.matches("\nGO\n").count() >= 5, "{}", script);
        assert!(!script.contains("FOREIGN_KEY_CHECKS"));
        assert!(!script.contains("SET search_path"));
    }

    #[test]
    fn sqlserver_insert_literal_expr_quotes_values_by_type() {
        assert_eq!(
            sqlserver_insert_literal_expr("[name]", "nvarchar"),
            "CASE WHEN [name] IS NULL THEN N'NULL' ELSE CONCAT(N'N''', REPLACE(CONVERT(nvarchar(max), [name]), N'''', N''''''), N'''') END"
        );
        assert_eq!(
            sqlserver_insert_literal_expr("[payload]", "varbinary"),
            "CASE WHEN [payload] IS NULL THEN N'NULL' ELSE CONVERT(nvarchar(max), sys.fn_varbintohexstr(CONVERT(varbinary(max), [payload]))) END"
        );
        assert_eq!(
            sqlserver_insert_literal_expr("[created_at]", "datetime2"),
            "CASE WHEN [created_at] IS NULL THEN N'NULL' ELSE CONCAT(N'N''', REPLACE(CONVERT(nvarchar(max), [created_at], 126), N'''', N''''''), N'''') END"
        );
        assert_eq!(
            sqlserver_insert_literal_expr("[amount]", "bigint"),
            "CASE WHEN [amount] IS NULL THEN N'NULL' ELSE CONVERT(nvarchar(max), [amount]) END"
        );
    }

    #[test]
    fn sqlserver_import_preview_detects_dangerous_go_batches() {
        let sql = "\
TRUNCATE TABLE [dbo].[users]\n\
GO\n\
SELECT N'TRUNCATE TABLE is only string data';\n\
GO\n\
DROP SCHEMA [old_schema]\n";

        let preview = preview_sql_file_dangerous_statements("sqlserver", sql);

        assert_eq!(preview.statements_total, 3);
        assert_eq!(preview.dangerous_statements.len(), 2);
        assert_eq!(preview.dangerous_statements[0].statement_index, 1);
        assert_eq!(
            preview.dangerous_statements[0].statement_preview,
            "TRUNCATE TABLE [dbo].[users]"
        );
        assert_eq!(preview.dangerous_statements[1].statement_index, 3);
        assert_eq!(
            preview.dangerous_statements[1].statement_preview,
            "DROP SCHEMA [old_schema]"
        );
    }

    #[test]
    fn clickhouse_import_splitter_keeps_format_payload_semicolons() {
        let sql = r#"
CREATE TABLE `analytics`.`events`
(
  `id` UInt64,
  `payload` String
)
ENGINE = MergeTree
ORDER BY id;

INSERT INTO `analytics`.`events` FORMAT JSONEachRow
{"id":1,"payload":"keeps;semicolon"}
{"id":2,"payload":"second row"}
;

INSERT INTO `analytics`.`events` (`id`, `payload`) VALUES (3, 'values;semicolon');
"#;

        let statements = split_import_sql_for_database_type("clickhouse", sql);

        assert_eq!(statements.len(), 3, "{:#?}", statements);
        assert!(statements[0].contains("CREATE TABLE `analytics`.`events`"));
        assert!(statements[0].contains("ORDER BY id"));
        assert!(statements[1].starts_with("INSERT INTO `analytics`.`events` FORMAT JSONEachRow"));
        assert!(statements[1].contains("keeps;semicolon"));
        assert!(statements[2].contains("VALUES (3, 'values;semicolon')"));
    }

    #[test]
    fn clickhouse_import_preview_detects_dangerous_statements() {
        let sql = r#"
SELECT 'DROP DATABASE is only data';
TRUNCATE TABLE `analytics`.`events`;
DROP DATABASE `old_analytics`;
"#;

        let preview = preview_sql_file_dangerous_statements("clickhouse", sql);

        assert_eq!(preview.statements_total, 3);
        assert_eq!(preview.dangerous_statements_total, 2);
        assert_eq!(preview.dangerous_statements[0].statement_index, 2);
        assert_eq!(
            preview.dangerous_statements[0].statement_preview,
            "TRUNCATE TABLE `analytics`.`events`"
        );
        assert_eq!(preview.dangerous_statements[1].statement_index, 3);
    }

    #[test]
    fn clickhouse_export_metadata_query_uses_single_system_tables_query() {
        let sql = build_clickhouse_export_metadata_sql();

        assert!(sql.contains("system.tables"));
        assert!(sql.contains("create_table_query"));
        assert!(sql.contains("database = ?"));
        assert!(!sql.contains("system.columns"));
    }

    #[test]
    fn clickhouse_values_row_count_counts_comma_separated_rows() {
        assert_eq!(
            count_clickhouse_values_rows("(1,'Ada'),(2,'Bob'),(3,'Eve')"),
            3
        );
        assert_eq!(
            count_clickhouse_values_rows("(1,'comma, inside string'),(2,'paren ) inside string')"),
            2
        );
    }

    #[test]
    fn sql_export_cancel_token_reports_cancelled() {
        let token = SqlExportCancelToken::new();

        assert!(token.check().is_ok());
        token.cancel();
        assert_eq!(token.check().unwrap_err(), "导出已取消");
    }

    #[test]
    fn clickhouse_export_script_includes_database_objects_and_values_data() {
        let metadata = ClickHouseExportMetadata {
            database: "analytics".to_string(),
            tables: vec![ClickHouseExportRelation {
                name: "events".to_string(),
                relation_kind: ClickHouseExportRelationKind::Table,
                ddl: "CREATE TABLE `analytics`.`events` (`id` UInt64, `payload` String) ENGINE = MergeTree ORDER BY id"
                    .to_string(),
            }],
            views: vec![ClickHouseExportRelation {
                name: "events_view".to_string(),
                relation_kind: ClickHouseExportRelationKind::View,
                ddl: "CREATE VIEW `analytics`.`events_view` AS SELECT id FROM `analytics`.`events`"
                    .to_string(),
            }],
        };
        let data = vec![ClickHouseExportDataBlock {
            table: "events".to_string(),
            rows_sql: "(1,'Ada')\n(2,'Bob')\n".to_string(),
            row_count: 2,
        }];

        let script = build_clickhouse_export_script(&metadata, &data, true, 100).unwrap();

        assert!(script.contains("CREATE DATABASE IF NOT EXISTS `analytics`;"));
        assert!(script.contains("USE `analytics`;"));
        assert!(script.contains("CREATE TABLE `analytics`.`events`"));
        assert!(script.contains("CREATE VIEW `analytics`.`events_view`"));
        assert!(script.contains("INSERT INTO `analytics`.`events` FORMAT Values"));
        assert!(script.contains("(1,'Ada')"));
        assert!(script.contains("-- ClickHouse data export is a per-table business loop"));
        assert!(!script.contains("FOREIGN_KEY_CHECKS"));
    }
}
