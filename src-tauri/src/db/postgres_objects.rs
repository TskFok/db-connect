//! PostgreSQL 对象适配：索引、外键、触发器、函数/过程的 catalog 查询与 DDL 构建。
//!
//! 设计要点：
//! - 标识符统一通过 `pg_id` 双引号转义，字符串字面值通过 `esc_pg_str_external` 单引号转义。
//! - SQL 构建（`build_*`）做成纯函数，便于单测，避免与执行逻辑漂移。
//! - 列表查询使用一次性批量 catalog 查询并在 SQL 内用 `unnest ... WITH ORDINALITY`
//!   还原列顺序，杜绝循环内逐列查库（N+1）。
//! - 错误信息走 `format_pg_error` 转中文，常见 SQLState 给出场景化提示。

use crate::db::postgres::{esc_pg_str_external, get_client_with_retry};
use crate::db::postgres_ddl::format_pg_error;
use crate::db::sql_utils::pg_id;
use crate::models::types::{
    AddForeignKeyRequest, CreateIndexRequest, CreateTriggerRequest, ForeignKeyInfo,
    IndexColumnInfo, IndexInfo, RoutineInfo, TriggerInfo,
};
use deadpool_postgres::Pool as PgPool;
use std::collections::BTreeMap;

// ============================
// 工具
// ============================

/// PostgreSQL 支持的索引访问方法白名单（防注入 + 限制为常用方法）。
const PG_INDEX_METHODS: &[&str] = &["btree", "hash", "gist", "gin", "spgist", "brin"];

/// 把外键动作代码（`a/r/c/n/d`）转换为标准引用动作文本。
fn fk_action_code_to_text(code: i8) -> String {
    match code as u8 as char {
        'a' => "NO ACTION".to_string(),
        'r' => "RESTRICT".to_string(),
        'c' => "CASCADE".to_string(),
        'n' => "SET NULL".to_string(),
        'd' => "SET DEFAULT".to_string(),
        _ => "NO ACTION".to_string(),
    }
}

fn validate_referential_action(rule: &str) -> Result<(), String> {
    match rule.trim().to_uppercase().as_str() {
        "RESTRICT" | "CASCADE" | "SET NULL" | "NO ACTION" | "SET DEFAULT" => Ok(()),
        _ => Err(format!(
            "无效的引用动作: {}（允许 RESTRICT、CASCADE、SET NULL、NO ACTION、SET DEFAULT）",
            rule
        )),
    }
}

/// `name` 为 `table` 或 `schema.table`，返回 (schema, table)。
fn parse_qualified_table(default_schema: &str, name: &str) -> Result<(String, String), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("被引用表名无效".to_string());
    }
    if let Some(dot) = name.rfind('.') {
        let (a, b) = name.split_at(dot);
        let a = a.trim();
        let b = b[1..].trim();
        if a.is_empty() || b.is_empty() {
            return Err("被引用表限定名格式无效".to_string());
        }
        Ok((a.to_string(), b.to_string()))
    } else {
        Ok((default_schema.to_string(), name.to_string()))
    }
}

// ============================
// 索引
// ============================

/// 构建 PostgreSQL 创建索引语句（含可选注释）。
///
/// 返回 SQL 列表：第一条为 `CREATE [UNIQUE] INDEX`，若有注释再追加 `COMMENT ON INDEX`。
pub fn build_create_index_sqls(
    schema: &str,
    table: &str,
    request: &CreateIndexRequest,
) -> Result<Vec<String>, String> {
    if request.index_name.trim().is_empty() {
        return Err("索引名称不能为空".to_string());
    }
    if request.columns.is_empty() {
        return Err("至少需要选择一列".to_string());
    }

    // PostgreSQL 仅区分唯一/普通索引；FULLTEXT/SPATIAL 等 MySQL 概念按普通索引处理。
    let unique = request.index_type.trim().to_uppercase() == "UNIQUE";

    // 索引方法：默认 btree，限制在白名单内。
    let method = match &request.index_method {
        Some(m) if !m.trim().is_empty() => {
            let lower = m.trim().to_lowercase();
            if !PG_INDEX_METHODS.contains(&lower.as_str()) {
                return Err(format!(
                    "PostgreSQL 不支持索引方法 {}（支持 {}）",
                    m,
                    PG_INDEX_METHODS.join("、")
                ));
            }
            lower
        }
        _ => "btree".to_string(),
    };

    let cols: Vec<String> = request
        .columns
        .iter()
        .map(|c| {
            let mut s = pg_id(c.column_name.trim());
            // PostgreSQL 普通列索引不支持 MySQL 的前缀长度（length 被忽略）。
            if let Some(order) = c.order.as_ref() {
                let upper = order.trim().to_uppercase();
                if upper == "ASC" || upper == "DESC" {
                    s.push_str(&format!(" {}", upper));
                }
            }
            s
        })
        .collect();

    let create_sql = format!(
        "CREATE {}INDEX {} ON {}.{} USING {} ({})",
        if unique { "UNIQUE " } else { "" },
        pg_id(request.index_name.trim()),
        pg_id(schema),
        pg_id(table),
        method,
        cols.join(", ")
    );

    let mut sqls = vec![create_sql];

    if let Some(comment) = request.comment.as_ref() {
        if !comment.trim().is_empty() {
            sqls.push(format!(
                "COMMENT ON INDEX {}.{} IS {}",
                pg_id(schema),
                pg_id(request.index_name.trim()),
                esc_pg_str_external(comment.trim())
            ));
        }
    }

    Ok(sqls)
}

/// 列出指定表的索引（含主键、唯一约束对应索引）。
pub async fn list_indexes(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let client = get_client_with_retry(pool).await?;
    let rows = client
        .query(
            "SELECT \
                i.relname AS index_name, \
                ix.indisunique AS is_unique, \
                ix.indisprimary AS is_primary, \
                am.amname AS index_type, \
                COALESCE(a.attname, '(expression)') AS column_name, \
                k.ord::int AS seq, \
                COALESCE(pg_catalog.obj_description(i.oid, 'pg_class'), '') AS comment, \
                (k.opt & 1) = 1 AS is_desc \
             FROM pg_catalog.pg_class t \
             JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace \
             JOIN pg_catalog.pg_index ix ON ix.indrelid = t.oid \
             JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_catalog.pg_am am ON am.oid = i.relam \
             JOIN LATERAL unnest( \
                    string_to_array(ix.indkey::text, ' ')::int[], \
                    string_to_array(ix.indoption::text, ' ')::int[] \
                  ) WITH ORDINALITY AS k(attnum, opt, ord) ON true \
             LEFT JOIN pg_catalog.pg_attribute a \
                    ON a.attrelid = t.oid AND a.attnum = k.attnum \
             WHERE n.nspname = $1 AND t.relname = $2 \
             ORDER BY i.relname, k.ord",
            &[&schema, &table],
        )
        .await
        .map_err(|e| format!("查询索引信息失败: {}", e))?;

    let mut index_map: BTreeMap<String, IndexInfo> = BTreeMap::new();

    for row in &rows {
        let index_name: String = row.get("index_name");
        let is_unique: bool = row.get("is_unique");
        let is_primary: bool = row.get("is_primary");
        let index_type: String = row.get::<_, String>("index_type").to_uppercase();
        let column_name: String = row.get("column_name");
        let seq: i32 = row.get("seq");
        let comment: String = row.get("comment");
        let is_desc: bool = row.get("is_desc");

        let col_info = IndexColumnInfo {
            column_name,
            seq_in_index: seq.max(0) as u32,
            // 复用 MySQL collation 字段表达排序方向（A=升序 D=降序），前端据此回填顺序。
            collation: Some(if is_desc {
                "D".to_string()
            } else {
                "A".to_string()
            }),
            sub_part: None,
        };

        index_map
            .entry(index_name.clone())
            .and_modify(|idx| idx.columns.push(col_info.clone()))
            .or_insert_with(|| IndexInfo {
                name: index_name.clone(),
                unique: is_unique,
                index_type: index_type.clone(),
                columns: vec![col_info],
                is_primary,
                comment,
            });
    }

    let mut indexes: Vec<IndexInfo> = index_map.into_values().collect();
    for idx in &mut indexes {
        idx.columns.sort_by_key(|c| c.seq_in_index);
    }
    Ok(indexes)
}

/// 创建索引。
pub async fn create_index(
    pool: &PgPool,
    schema: &str,
    table: &str,
    request: &CreateIndexRequest,
) -> Result<(), String> {
    let sqls = build_create_index_sqls(schema, table, request)?;
    let client = get_client_with_retry(pool).await?;
    for sql in &sqls {
        client
            .simple_query(sql)
            .await
            .map_err(|e| format_pg_error("创建索引", e))?;
    }
    Ok(())
}

/// 删除索引。若索引对应唯一/主键约束，需通过 `ALTER TABLE ... DROP CONSTRAINT`。
pub async fn drop_index(
    pool: &PgPool,
    schema: &str,
    table: &str,
    index_name: &str,
) -> Result<(), String> {
    let name = index_name.trim();
    if name.is_empty() {
        return Err("索引名称不能为空".to_string());
    }

    let client = get_client_with_retry(pool).await?;

    // 主键/唯一约束的后备索引与约束同名，必须按约束删除。
    let constraint = client
        .query_opt(
            "SELECT con.conname \
             FROM pg_catalog.pg_constraint con \
             JOIN pg_catalog.pg_class t ON t.oid = con.conrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace \
             WHERE n.nspname = $1 AND t.relname = $2 \
               AND con.conname = $3 AND con.contype IN ('p', 'u')",
            &[&schema, &table, &name],
        )
        .await
        .map_err(|e| format_pg_error("查询约束信息", e))?;

    let sql = if constraint.is_some() {
        format!(
            "ALTER TABLE {}.{} DROP CONSTRAINT {}",
            pg_id(schema),
            pg_id(table),
            pg_id(name)
        )
    } else {
        format!("DROP INDEX {}.{}", pg_id(schema), pg_id(name))
    };

    client
        .simple_query(&sql)
        .await
        .map_err(|e| format_pg_error("删除索引", e))?;
    Ok(())
}

// ============================
// 外键
// ============================

/// 构建 PostgreSQL 添加外键语句。
pub fn build_add_foreign_key_sql(
    schema: &str,
    table: &str,
    request: &AddForeignKeyRequest,
) -> Result<String, String> {
    if request.constraint_name.trim().is_empty() {
        return Err("约束名不能为空".to_string());
    }
    if request.columns.is_empty() {
        return Err("至少需要一列本地列".to_string());
    }
    if request.referenced_columns.len() != request.columns.len() {
        return Err("本地列与引用列数量必须一致".to_string());
    }
    if request.referenced_table.trim().is_empty() {
        return Err("被引用表不能为空".to_string());
    }
    validate_referential_action(&request.on_update)?;
    validate_referential_action(&request.on_delete)?;

    let cols: Vec<String> = request.columns.iter().map(|c| pg_id(c.trim())).collect();
    let refcols: Vec<String> = request
        .referenced_columns
        .iter()
        .map(|c| pg_id(c.trim()))
        .collect();

    let (ref_schema, ref_tbl) = parse_qualified_table(schema, &request.referenced_table)?;

    Ok(format!(
        "ALTER TABLE {}.{} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{} ({}) ON UPDATE {} ON DELETE {}",
        pg_id(schema),
        pg_id(table),
        pg_id(request.constraint_name.trim()),
        cols.join(", "),
        pg_id(&ref_schema),
        pg_id(&ref_tbl),
        refcols.join(", "),
        request.on_update.trim().to_uppercase(),
        request.on_delete.trim().to_uppercase()
    ))
}

/// 构建删除外键语句。
pub fn build_drop_foreign_key_sql(schema: &str, table: &str, constraint_name: &str) -> String {
    format!(
        "ALTER TABLE {}.{} DROP CONSTRAINT {}",
        pg_id(schema),
        pg_id(table),
        pg_id(constraint_name.trim())
    )
}

/// 列出与指定表相关的外键（本表作为子表 outgoing，或作为父表被引用 incoming）。
pub async fn list_foreign_keys(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let client = get_client_with_retry(pool).await?;
    let rows = client
        .query(
            "SELECT \
                con.conname AS constraint_name, \
                ns.nspname AS table_schema, \
                cl.relname AS table_name, \
                fns.nspname AS ref_schema, \
                fcl.relname AS ref_table, \
                con.confupdtype AS update_code, \
                con.confdeltype AS delete_code, \
                ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord) \
                      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.attnum \
                      ORDER BY u.ord) AS col_names, \
                ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY AS u(attnum, ord) \
                      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = u.attnum \
                      ORDER BY u.ord) AS ref_col_names \
             FROM pg_catalog.pg_constraint con \
             JOIN pg_catalog.pg_class cl ON cl.oid = con.conrelid \
             JOIN pg_catalog.pg_namespace ns ON ns.oid = cl.relnamespace \
             JOIN pg_catalog.pg_class fcl ON fcl.oid = con.confrelid \
             JOIN pg_catalog.pg_namespace fns ON fns.oid = fcl.relnamespace \
             WHERE con.contype = 'f' \
               AND ( (ns.nspname = $1 AND cl.relname = $2) \
                     OR (fns.nspname = $1 AND fcl.relname = $2) ) \
             ORDER BY con.conname",
            &[&schema, &table],
        )
        .await
        .map_err(|e| format!("查询外键信息失败: {}", e))?;

    let mut result: Vec<ForeignKeyInfo> = rows
        .iter()
        .map(|row| {
            let table_schema: String = row.get("table_schema");
            let table_name: String = row.get("table_name");
            let direction = if table_schema == schema && table_name == table {
                "outgoing".to_string()
            } else {
                "incoming".to_string()
            };
            ForeignKeyInfo {
                constraint_name: row.get("constraint_name"),
                direction,
                table_schema,
                table_name,
                column_names: row.get("col_names"),
                referenced_table_schema: row.get("ref_schema"),
                referenced_table_name: row.get("ref_table"),
                referenced_column_names: row.get("ref_col_names"),
                update_rule: fk_action_code_to_text(row.get::<_, i8>("update_code")),
                delete_rule: fk_action_code_to_text(row.get::<_, i8>("delete_code")),
            }
        })
        .collect();

    result.sort_by(|a, b| {
        a.direction
            .cmp(&b.direction)
            .then_with(|| a.constraint_name.cmp(&b.constraint_name))
    });

    Ok(result)
}

/// 添加外键。
pub async fn add_foreign_key(
    pool: &PgPool,
    schema: &str,
    table: &str,
    request: &AddForeignKeyRequest,
) -> Result<(), String> {
    let sql = build_add_foreign_key_sql(schema, table, request)?;
    let client = get_client_with_retry(pool).await?;
    client
        .simple_query(&sql)
        .await
        .map_err(|e| format_pg_error("添加外键", e))?;
    Ok(())
}

/// 删除外键。
pub async fn drop_foreign_key(
    pool: &PgPool,
    schema: &str,
    table: &str,
    constraint_name: &str,
) -> Result<(), String> {
    if constraint_name.trim().is_empty() {
        return Err("约束名不能为空".to_string());
    }
    let sql = build_drop_foreign_key_sql(schema, table, constraint_name);
    let client = get_client_with_retry(pool).await?;
    client
        .simple_query(&sql)
        .await
        .map_err(|e| format_pg_error("删除外键", e))?;
    Ok(())
}

// ============================
// 触发器
// ============================

/// 从 `tgtype` bit 位解析触发时机（BEFORE / AFTER / INSTEAD OF）。
pub fn trigger_timing_from_tgtype(tgtype: i16) -> String {
    const INSTEAD: i16 = 1 << 6;
    const BEFORE: i16 = 1 << 1;
    if tgtype & INSTEAD != 0 {
        "INSTEAD OF".to_string()
    } else if tgtype & BEFORE != 0 {
        "BEFORE".to_string()
    } else {
        "AFTER".to_string()
    }
}

/// 从 `tgtype` bit 位解析触发事件（INSERT / UPDATE / DELETE / TRUNCATE，可组合）。
pub fn trigger_events_from_tgtype(tgtype: i16) -> String {
    const INSERT: i16 = 1 << 2;
    const DELETE: i16 = 1 << 3;
    const UPDATE: i16 = 1 << 4;
    const TRUNCATE: i16 = 1 << 5;
    let mut events = Vec::new();
    if tgtype & INSERT != 0 {
        events.push("INSERT");
    }
    if tgtype & UPDATE != 0 {
        events.push("UPDATE");
    }
    if tgtype & DELETE != 0 {
        events.push("DELETE");
    }
    if tgtype & TRUNCATE != 0 {
        events.push("TRUNCATE");
    }
    events.join(" OR ")
}

/// 从 `pg_get_triggerdef` 文本中提取 `EXECUTE FUNCTION/PROCEDURE ...` 片段作为语句体展示。
pub fn extract_trigger_action(def: &str) -> String {
    if let Some(idx) = def.to_uppercase().find("EXECUTE ") {
        def[idx..].trim().trim_end_matches(';').to_string()
    } else {
        def.trim().to_string()
    }
}

/// 构建 PostgreSQL 创建触发器语句。
///
/// PostgreSQL 触发器必须调用已存在的触发器函数，因此 `body` 应包含
/// `EXECUTE FUNCTION fn()`（或兼容旧语法 `EXECUTE PROCEDURE fn()`）。
pub fn build_create_trigger_sql(
    schema: &str,
    table: &str,
    request: &CreateTriggerRequest,
) -> String {
    format!(
        "CREATE TRIGGER {} {} {} ON {}.{}\nFOR EACH ROW\n{}",
        pg_id(&request.name),
        request.timing.trim().to_uppercase(),
        request.event.trim().to_uppercase(),
        pg_id(schema),
        pg_id(table),
        request.body.trim()
    )
}

/// 校验 PostgreSQL 触发器参数。
pub fn validate_trigger_params(request: &CreateTriggerRequest) -> Result<(), String> {
    if request.name.trim().is_empty() {
        return Err("触发器名称不能为空".to_string());
    }
    if request.body.trim().is_empty() {
        return Err("触发器执行动作不能为空（PostgreSQL 需指定 EXECUTE FUNCTION ...）".to_string());
    }
    match request.timing.trim().to_uppercase().as_str() {
        "BEFORE" | "AFTER" | "INSTEAD OF" => {}
        _ => return Err("触发器时机必须为 BEFORE、AFTER 或 INSTEAD OF".to_string()),
    }
    match request.event.trim().to_uppercase().as_str() {
        "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE" => {}
        _ => return Err("触发器事件必须为 INSERT、UPDATE、DELETE 或 TRUNCATE".to_string()),
    }
    Ok(())
}

/// 列出触发器，可按表名筛选。
pub async fn list_triggers(
    pool: &PgPool,
    schema: &str,
    table: Option<&str>,
) -> Result<Vec<TriggerInfo>, String> {
    let client = get_client_with_retry(pool).await?;
    let rows = match table {
        Some(t) => {
            client
                .query(
                    "SELECT t.tgname AS name, c.relname AS table_name, \
                            t.tgtype::int AS tgtype, pg_get_triggerdef(t.oid, true) AS definition \
                     FROM pg_catalog.pg_trigger t \
                     JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
                     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                     WHERE NOT t.tgisinternal AND n.nspname = $1 AND c.relname = $2 \
                     ORDER BY c.relname, t.tgname",
                    &[&schema, &t],
                )
                .await
        }
        None => {
            client
                .query(
                    "SELECT t.tgname AS name, c.relname AS table_name, \
                            t.tgtype::int AS tgtype, pg_get_triggerdef(t.oid, true) AS definition \
                     FROM pg_catalog.pg_trigger t \
                     JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
                     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                     WHERE NOT t.tgisinternal AND n.nspname = $1 \
                     ORDER BY c.relname, t.tgname",
                    &[&schema],
                )
                .await
        }
    }
    .map_err(|e| format!("查询触发器列表失败: {}", e))?;

    Ok(rows
        .iter()
        .map(|row| {
            let tgtype = row.get::<_, i32>("tgtype") as i16;
            let definition: String = row.get("definition");
            TriggerInfo {
                name: row.get("name"),
                event: trigger_events_from_tgtype(tgtype),
                timing: trigger_timing_from_tgtype(tgtype),
                table_name: row.get("table_name"),
                statement: extract_trigger_action(&definition),
                created: None,
                sql_mode: String::new(),
                definer: String::new(),
            }
        })
        .collect())
}

/// 获取触发器完整定义（`pg_get_triggerdef`）。table 为空时按名称在 schema 内取首个。
pub async fn get_trigger_definition(
    pool: &PgPool,
    schema: &str,
    table: Option<&str>,
    trigger_name: &str,
) -> Result<String, String> {
    let client = get_client_with_retry(pool).await?;
    let row = match table {
        Some(t) if !t.trim().is_empty() => {
            client
                .query_opt(
                    "SELECT pg_get_triggerdef(t.oid, true) AS def \
                     FROM pg_catalog.pg_trigger t \
                     JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
                     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                     WHERE NOT t.tgisinternal AND n.nspname = $1 AND c.relname = $2 AND t.tgname = $3",
                    &[&schema, &t, &trigger_name],
                )
                .await
        }
        _ => {
            client
                .query_opt(
                    "SELECT pg_get_triggerdef(t.oid, true) AS def \
                     FROM pg_catalog.pg_trigger t \
                     JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
                     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                     WHERE NOT t.tgisinternal AND n.nspname = $1 AND t.tgname = $2 \
                     LIMIT 1",
                    &[&schema, &trigger_name],
                )
                .await
        }
    }
    .map_err(|e| format!("查询触发器定义失败: {}", e))?;

    row.map(|r| r.get::<_, String>("def"))
        .ok_or_else(|| format!("触发器 '{}' 不存在", trigger_name))
}

/// 创建触发器。
pub async fn create_trigger(
    pool: &PgPool,
    schema: &str,
    table: &str,
    request: &CreateTriggerRequest,
) -> Result<(), String> {
    validate_trigger_params(request)?;
    let sql = build_create_trigger_sql(schema, table, request);
    let client = get_client_with_retry(pool).await?;
    client
        .simple_query(&sql)
        .await
        .map_err(|e| format_pg_error("创建触发器", e))?;
    Ok(())
}

/// 删除触发器。PostgreSQL 需要表名定位触发器。
pub async fn drop_trigger(
    pool: &PgPool,
    schema: &str,
    table: Option<&str>,
    trigger_name: &str,
) -> Result<(), String> {
    if trigger_name.trim().is_empty() {
        return Err("触发器名称不能为空".to_string());
    }
    let client = get_client_with_retry(pool).await?;

    // 未提供表名时，从 catalog 反查触发器所在表。
    let table_name = match table {
        Some(t) if !t.trim().is_empty() => t.trim().to_string(),
        _ => {
            let row = client
                .query_opt(
                    "SELECT c.relname AS table_name \
                     FROM pg_catalog.pg_trigger t \
                     JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
                     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                     WHERE NOT t.tgisinternal AND n.nspname = $1 AND t.tgname = $2 \
                     LIMIT 1",
                    &[&schema, &trigger_name],
                )
                .await
                .map_err(|e| format!("查询触发器所在表失败: {}", e))?;
            row.map(|r| r.get::<_, String>("table_name"))
                .ok_or_else(|| format!("触发器 '{}' 不存在", trigger_name))?
        }
    };

    let sql = format!(
        "DROP TRIGGER IF EXISTS {} ON {}.{}",
        pg_id(trigger_name.trim()),
        pg_id(schema),
        pg_id(&table_name)
    );
    client
        .simple_query(&sql)
        .await
        .map_err(|e| format_pg_error("删除触发器", e))?;
    Ok(())
}

// ============================
// 函数 / 过程
// ============================

/// 把外部 routine_type 文本映射为 pg_proc.prokind 文本（'f'/'p'）。
fn routine_kind_char(routine_type: &str) -> Result<&'static str, String> {
    match routine_type.trim().to_uppercase().as_str() {
        "FUNCTION" => Ok("f"),
        "PROCEDURE" => Ok("p"),
        _ => Err("例程类型必须为 PROCEDURE 或 FUNCTION".to_string()),
    }
}

/// 列出 schema 下的函数与过程（不含聚合/窗口函数）。
pub async fn list_routines(
    pool: &PgPool,
    schema: &str,
    routine_type: Option<&str>,
) -> Result<Vec<RoutineInfo>, String> {
    let client = get_client_with_retry(pool).await?;

    let base = "SELECT \
            p.proname AS name, \
            CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS routine_type, \
            CASE WHEN p.prokind = 'p' THEN NULL ELSE pg_catalog.format_type(p.prorettype, NULL) END AS data_type, \
            pg_catalog.pg_get_userbyid(p.proowner) AS definer, \
            CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END AS security_type, \
            COALESCE(pg_catalog.obj_description(p.oid, 'pg_proc'), '') AS routine_comment, \
            pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments \
         FROM pg_catalog.pg_proc p \
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
         WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')";

    let rows = match routine_type {
        Some(t) if !t.trim().is_empty() => {
            let kind = routine_kind_char(t)?;
            let sql = format!(
                "{} AND p.prokind::text = $2 ORDER BY routine_type, p.proname",
                base
            );
            client.query(&sql, &[&schema, &kind]).await
        }
        _ => {
            let sql = format!("{} ORDER BY routine_type, p.proname", base);
            client.query(&sql, &[&schema]).await
        }
    }
    .map_err(|e| format!("查询例程列表失败: {}", e))?;

    Ok(rows
        .iter()
        .map(|row| RoutineInfo {
            name: row.get("name"),
            routine_type: row.get("routine_type"),
            data_type: row.get("data_type"),
            definer: row.get("definer"),
            security_type: row.get("security_type"),
            routine_comment: row.get("routine_comment"),
            created: None,
            last_altered: None,
            identity_arguments: Some(row.get("identity_arguments")),
        })
        .collect())
}

/// 获取函数/过程定义（`pg_get_functiondef`）。
pub async fn get_routine_definition(
    pool: &PgPool,
    schema: &str,
    routine_name: &str,
    routine_type: &str,
    identity_arguments: Option<&str>,
) -> Result<String, String> {
    if routine_name.trim().is_empty() {
        return Err("例程名称不能为空".to_string());
    }
    let kind = routine_kind_char(routine_type)?;
    let client = get_client_with_retry(pool).await?;
    let row = match identity_arguments {
        Some(args) => {
            client
                .query_opt(
                    "SELECT pg_get_functiondef(p.oid) AS def \
                     FROM pg_catalog.pg_proc p \
                     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
                     WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind::text = $3 \
                       AND pg_catalog.pg_get_function_identity_arguments(p.oid) = $4",
                    &[&schema, &routine_name.trim(), &kind, &args],
                )
                .await
        }
        None => {
            client
                .query_opt(
                    "SELECT pg_get_functiondef(p.oid) AS def \
                     FROM pg_catalog.pg_proc p \
                     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
                     WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind::text = $3 \
                     LIMIT 1",
                    &[&schema, &routine_name.trim(), &kind],
                )
                .await
        }
    }
    .map_err(|e| format!("获取例程定义失败: {}", e))?;

    row.map(|r| r.get::<_, String>("def"))
        .ok_or_else(|| format!("例程 '{}' 不存在", routine_name.trim()))
}

pub fn build_drop_routine_sql(
    schema: &str,
    routine_name: &str,
    routine_type: &str,
    identity_arguments: &str,
) -> Result<String, String> {
    let kind = routine_kind_char(routine_type)?;
    let keyword = if kind == "p" { "PROCEDURE" } else { "FUNCTION" };
    Ok(format!(
        "DROP {} {}.{}({})",
        keyword,
        pg_id(schema),
        pg_id(routine_name.trim()),
        identity_arguments
    ))
}

/// 删除函数/过程。带参数签名以支持重载。
pub async fn drop_routine(
    pool: &PgPool,
    schema: &str,
    routine_name: &str,
    routine_type: &str,
    identity_arguments: Option<&str>,
) -> Result<(), String> {
    if routine_name.trim().is_empty() {
        return Err("例程名称不能为空".to_string());
    }
    let kind = routine_kind_char(routine_type)?;
    let client = get_client_with_retry(pool).await?;

    let row = match identity_arguments {
        Some(args) => {
            client
                .query_opt(
                    "SELECT pg_get_function_identity_arguments(p.oid) AS args \
                     FROM pg_catalog.pg_proc p \
                     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
                     WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind::text = $3 \
                       AND pg_catalog.pg_get_function_identity_arguments(p.oid) = $4",
                    &[&schema, &routine_name.trim(), &kind, &args],
                )
                .await
        }
        None => {
            client
                .query_opt(
                    "SELECT pg_get_function_identity_arguments(p.oid) AS args \
                     FROM pg_catalog.pg_proc p \
                     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
                     WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind::text = $3 \
                     LIMIT 1",
                    &[&schema, &routine_name.trim(), &kind],
                )
                .await
        }
    }
    .map_err(|e| format!("查询例程信息失败: {}", e))?;

    let args: String = row
        .map(|r| r.get::<_, String>("args"))
        .ok_or_else(|| format!("例程 '{}' 不存在", routine_name.trim()))?;

    let sql = build_drop_routine_sql(schema, routine_name, routine_type, &args)?;
    client
        .simple_query(&sql)
        .await
        .map_err(|e| format_pg_error("删除例程", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::CreateIndexColumn;

    #[test]
    fn build_create_index_normal() {
        let req = CreateIndexRequest {
            index_name: "idx_name".to_string(),
            index_type: "INDEX".to_string(),
            index_method: None,
            columns: vec![CreateIndexColumn {
                column_name: "name".to_string(),
                length: Some(20),
                order: None,
            }],
            comment: None,
        };
        let sqls = build_create_index_sqls("public", "users", &req).unwrap();
        assert_eq!(sqls.len(), 1);
        // 前缀长度被忽略；默认 btree。
        assert_eq!(
            sqls[0],
            "CREATE INDEX \"idx_name\" ON \"public\".\"users\" USING btree (\"name\")"
        );
    }

    #[test]
    fn build_create_index_unique_with_method_order_and_comment() {
        let req = CreateIndexRequest {
            index_name: "idx_email".to_string(),
            index_type: "UNIQUE".to_string(),
            index_method: Some("BTREE".to_string()),
            columns: vec![
                CreateIndexColumn {
                    column_name: "email".to_string(),
                    length: None,
                    order: Some("DESC".to_string()),
                },
                CreateIndexColumn {
                    column_name: "created_at".to_string(),
                    length: None,
                    order: Some("ASC".to_string()),
                },
            ],
            comment: Some("邮箱唯一索引".to_string()),
        };
        let sqls = build_create_index_sqls("app", "users", &req).unwrap();
        assert_eq!(sqls.len(), 2);
        assert_eq!(
            sqls[0],
            "CREATE UNIQUE INDEX \"idx_email\" ON \"app\".\"users\" USING btree (\"email\" DESC, \"created_at\" ASC)"
        );
        assert_eq!(
            sqls[1],
            "COMMENT ON INDEX \"app\".\"idx_email\" IS '邮箱唯一索引'"
        );
    }

    #[test]
    fn build_create_index_rejects_unknown_method() {
        let req = CreateIndexRequest {
            index_name: "idx".to_string(),
            index_type: "INDEX".to_string(),
            index_method: Some("FULLTEXT".to_string()),
            columns: vec![CreateIndexColumn {
                column_name: "c".to_string(),
                length: None,
                order: None,
            }],
            comment: None,
        };
        assert!(build_create_index_sqls("public", "t", &req).is_err());
    }

    #[test]
    fn build_create_index_rejects_empty() {
        let req = CreateIndexRequest {
            index_name: "".to_string(),
            index_type: "INDEX".to_string(),
            index_method: None,
            columns: vec![],
            comment: None,
        };
        assert!(build_create_index_sqls("public", "t", &req).is_err());
    }

    #[test]
    fn build_add_foreign_key_basic() {
        let req = AddForeignKeyRequest {
            constraint_name: "fk_user".to_string(),
            columns: vec!["user_id".to_string()],
            referenced_table: "users".to_string(),
            referenced_columns: vec!["id".to_string()],
            on_update: "CASCADE".to_string(),
            on_delete: "RESTRICT".to_string(),
        };
        let s = build_add_foreign_key_sql("public", "orders", &req).unwrap();
        assert_eq!(
            s,
            "ALTER TABLE \"public\".\"orders\" ADD CONSTRAINT \"fk_user\" FOREIGN KEY (\"user_id\") REFERENCES \"public\".\"users\" (\"id\") ON UPDATE CASCADE ON DELETE RESTRICT"
        );
    }

    #[test]
    fn build_add_foreign_key_qualified_ref() {
        let req = AddForeignKeyRequest {
            constraint_name: "fk_x".to_string(),
            columns: vec!["a".to_string(), "b".to_string()],
            referenced_table: "other.refs".to_string(),
            referenced_columns: vec!["x".to_string(), "y".to_string()],
            on_update: "NO ACTION".to_string(),
            on_delete: "SET NULL".to_string(),
        };
        let s = build_add_foreign_key_sql("app", "t1", &req).unwrap();
        assert!(s.contains("REFERENCES \"other\".\"refs\" (\"x\", \"y\")"));
        assert!(s.contains("ON DELETE SET NULL"));
    }

    #[test]
    fn build_add_foreign_key_rejects_mismatched_columns() {
        let req = AddForeignKeyRequest {
            constraint_name: "fk".to_string(),
            columns: vec!["a".to_string()],
            referenced_table: "b".to_string(),
            referenced_columns: vec!["x".to_string(), "y".to_string()],
            on_update: "RESTRICT".to_string(),
            on_delete: "RESTRICT".to_string(),
        };
        assert!(build_add_foreign_key_sql("public", "t", &req).is_err());
    }

    #[test]
    fn drop_foreign_key_sql_shape() {
        assert_eq!(
            build_drop_foreign_key_sql("public", "orders", "fk_o"),
            "ALTER TABLE \"public\".\"orders\" DROP CONSTRAINT \"fk_o\""
        );
    }

    #[test]
    fn fk_action_codes() {
        assert_eq!(fk_action_code_to_text(b'c' as i8), "CASCADE");
        assert_eq!(fk_action_code_to_text(b'n' as i8), "SET NULL");
        assert_eq!(fk_action_code_to_text(b'a' as i8), "NO ACTION");
        assert_eq!(fk_action_code_to_text(b'r' as i8), "RESTRICT");
        assert_eq!(fk_action_code_to_text(b'd' as i8), "SET DEFAULT");
    }

    #[test]
    fn trigger_timing_parsing() {
        assert_eq!(trigger_timing_from_tgtype(1 << 1), "BEFORE");
        assert_eq!(trigger_timing_from_tgtype(0), "AFTER");
        assert_eq!(trigger_timing_from_tgtype(1 << 6), "INSTEAD OF");
    }

    #[test]
    fn trigger_events_parsing() {
        // INSERT (4) | UPDATE (16)
        assert_eq!(
            trigger_events_from_tgtype((1 << 2) | (1 << 4)),
            "INSERT OR UPDATE"
        );
        assert_eq!(trigger_events_from_tgtype(1 << 3), "DELETE");
        assert_eq!(trigger_events_from_tgtype(1 << 5), "TRUNCATE");
    }

    #[test]
    fn extract_trigger_action_picks_execute_clause() {
        let def = "CREATE TRIGGER audit AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION log_change();";
        assert_eq!(extract_trigger_action(def), "EXECUTE FUNCTION log_change()");
    }

    #[test]
    fn build_create_trigger_sql_shape() {
        let req = CreateTriggerRequest {
            name: "trg_audit".to_string(),
            timing: "after".to_string(),
            event: "insert".to_string(),
            body: "EXECUTE FUNCTION log_change()".to_string(),
        };
        let sql = build_create_trigger_sql("public", "users", &req);
        assert!(sql.contains("CREATE TRIGGER \"trg_audit\" AFTER INSERT ON \"public\".\"users\""));
        assert!(sql.contains("FOR EACH ROW"));
        assert!(sql.contains("EXECUTE FUNCTION log_change()"));
    }

    #[test]
    fn validate_trigger_params_rules() {
        let ok = CreateTriggerRequest {
            name: "t".to_string(),
            timing: "BEFORE".to_string(),
            event: "UPDATE".to_string(),
            body: "EXECUTE FUNCTION f()".to_string(),
        };
        assert!(validate_trigger_params(&ok).is_ok());

        let bad_timing = CreateTriggerRequest {
            timing: "DURING".to_string(),
            ..ok.clone()
        };
        assert!(validate_trigger_params(&bad_timing).is_err());

        let bad_event = CreateTriggerRequest {
            event: "SELECT".to_string(),
            ..ok.clone()
        };
        assert!(validate_trigger_params(&bad_event).is_err());

        let empty_body = CreateTriggerRequest {
            body: "  ".to_string(),
            ..ok.clone()
        };
        assert!(validate_trigger_params(&empty_body).is_err());
    }

    #[test]
    fn routine_kind_mapping() {
        assert_eq!(routine_kind_char("function").unwrap(), "f");
        assert_eq!(routine_kind_char("PROCEDURE").unwrap(), "p");
        assert!(routine_kind_char("VIEW").is_err());
    }

    #[test]
    fn routine_info_carries_identity_arguments() {
        let routine = RoutineInfo {
            name: "calculate".to_string(),
            routine_type: "FUNCTION".to_string(),
            data_type: Some("integer".to_string()),
            definer: "postgres".to_string(),
            security_type: "INVOKER".to_string(),
            routine_comment: String::new(),
            created: None,
            last_altered: None,
            identity_arguments: Some("value integer".to_string()),
        };

        let json = serde_json::to_value(routine).unwrap();
        assert_eq!(json["identity_arguments"], "value integer");
    }

    #[test]
    fn build_drop_routine_uses_identity_arguments() {
        let sql = build_drop_routine_sql(
            "public",
            "calculate",
            "FUNCTION",
            "value integer, factor numeric",
        )
        .unwrap();
        assert_eq!(
            sql,
            "DROP FUNCTION \"public\".\"calculate\"(value integer, factor numeric)"
        );
    }

    #[test]
    fn parse_qualified_table_variants() {
        assert_eq!(
            parse_qualified_table("public", "users").unwrap(),
            ("public".to_string(), "users".to_string())
        );
        assert_eq!(
            parse_qualified_table("public", "app.users").unwrap(),
            ("app".to_string(), "users".to_string())
        );
        assert!(parse_qualified_table("public", "").is_err());
    }
}
