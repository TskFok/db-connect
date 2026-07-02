//! SQL Server 对象适配：索引、外键、触发器、存储过程/函数的 catalog 查询与 DDL 构建。
//!
//! 设计要点：
//! - 标识符统一通过 `sqlserver_id` 方括号转义，字符串字面量通过 `sqlserver_str` 转义。
//! - 列表查询使用一次性 catalog 查询后在内存聚合，避免循环遍历中查询 SQL。
//! - 创建索引首版只支持普通/唯一索引；触发器创建首版只支持 AFTER INSERT/UPDATE/DELETE。
//! - routine 在本阶段仅支持列表与定义查看；EVENT 明确返回不支持。

use crate::db::sql_utils::{sqlserver_id, sqlserver_str};
use crate::db::sqlserver::{normalize_sqlserver_error, SqlServerPool};
use crate::models::types::{
    AddForeignKeyRequest, CreateIndexRequest, CreateTriggerRequest, ForeignKeyInfo,
    IndexColumnInfo, IndexInfo, RoutineInfo, TriggerInfo,
};
use std::collections::BTreeMap;
use tiberius::Row;

const SQLSERVER_ROUTINE_PROCEDURE_TYPES: &[&str] = &["P", "PC"];
const SQLSERVER_ROUTINE_FUNCTION_TYPES: &[&str] = &["FN", "IF", "TF", "FS", "FT"];

fn n_str(value: &str) -> String {
    format!("N{}", sqlserver_str(value))
}

fn row_string(row: &Row, name: &str) -> String {
    row.get::<&str, _>(name).unwrap_or("").to_string()
}

fn row_opt_string(row: &Row, name: &str) -> Option<String> {
    row.get::<&str, _>(name)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

async fn run_sql(pool: &SqlServerPool, action: &str, sql: &str) -> Result<(), String> {
    let mut client = pool
        .get()
        .await
        .map_err(|e| normalize_sqlserver_error("获取连接失败", e.to_string()))?;
    client
        .simple_query(sql)
        .await
        .map_err(|e| normalize_sqlserver_error(action, e.to_string()))?
        .into_results()
        .await
        .map_err(|e| normalize_sqlserver_error(action, e.to_string()))?;
    Ok(())
}

fn unsupported_index_type_message(index_type: &str) -> String {
    format!(
        "SQL Server 暂不支持通过当前入口创建 {} 索引；本阶段仅支持普通索引和唯一索引",
        index_type
    )
}

fn validate_index_request(request: &CreateIndexRequest) -> Result<bool, String> {
    if request.index_name.trim().is_empty() {
        return Err("索引名称不能为空".to_string());
    }
    if request.columns.is_empty() {
        return Err("至少需要选择一列".to_string());
    }

    let index_type = request.index_type.trim().to_uppercase();
    let unique = match index_type.as_str() {
        "" | "INDEX" | "NONCLUSTERED" | "CLUSTERED" => false,
        "UNIQUE" => true,
        "FULLTEXT"
        | "SPATIAL"
        | "COLUMNSTORE"
        | "CLUSTERED COLUMNSTORE"
        | "NONCLUSTERED COLUMNSTORE" => {
            return Err(unsupported_index_type_message(&request.index_type));
        }
        other => {
            return Err(format!(
                "SQL Server 暂不支持索引类型 {}；本阶段仅支持 INDEX 和 UNIQUE",
                other
            ));
        }
    };

    if let Some(method) = request.index_method.as_ref() {
        let method = method.trim();
        if !method.is_empty() && !method.eq_ignore_ascii_case("BTREE") {
            return Err(format!(
                "SQL Server 暂不支持索引方法 {}；请留空后创建普通/唯一索引",
                method
            ));
        }
    }

    Ok(unique)
}

pub fn build_create_index_sql(
    schema: &str,
    table: &str,
    request: &CreateIndexRequest,
) -> Result<String, String> {
    let unique = validate_index_request(request)?;
    let columns: Result<Vec<String>, String> = request
        .columns
        .iter()
        .map(|col| {
            let name = col.column_name.trim();
            if name.is_empty() {
                return Err("索引列名不能为空".to_string());
            }
            let mut sql = sqlserver_id(name);
            if let Some(order) = col.order.as_ref() {
                let order = order.trim().to_uppercase();
                if order == "ASC" || order == "DESC" {
                    sql.push_str(&format!(" {}", order));
                }
            }
            Ok(sql)
        })
        .collect();

    Ok(format!(
        "CREATE {}INDEX {} ON {}.{} ({})",
        if unique { "UNIQUE " } else { "" },
        sqlserver_id(request.index_name.trim()),
        sqlserver_id(schema),
        sqlserver_id(table),
        columns?.join(", ")
    ))
}

pub fn build_drop_index_sql(
    schema: &str,
    table: &str,
    index_name: &str,
    is_constraint_backed: bool,
) -> Result<String, String> {
    let name = index_name.trim();
    if name.is_empty() {
        return Err("索引名称不能为空".to_string());
    }
    if is_constraint_backed {
        Ok(format!(
            "ALTER TABLE {}.{} DROP CONSTRAINT {}",
            sqlserver_id(schema),
            sqlserver_id(table),
            sqlserver_id(name)
        ))
    } else {
        Ok(format!(
            "DROP INDEX {} ON {}.{}",
            sqlserver_id(name),
            sqlserver_id(schema),
            sqlserver_id(table)
        ))
    }
}

#[derive(Debug, Clone)]
pub(crate) struct SqlServerIndexRow {
    pub index_name: String,
    pub unique: bool,
    pub primary: bool,
    pub index_type: String,
    pub column_name: String,
    pub key_ordinal: u32,
    pub descending: bool,
    pub included: bool,
    pub comment: String,
}

impl SqlServerIndexRow {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        index_name: &str,
        unique: bool,
        primary: bool,
        index_type: &str,
        column_name: &str,
        key_ordinal: u32,
        descending: bool,
        included: bool,
        comment: &str,
    ) -> Self {
        Self {
            index_name: index_name.to_string(),
            unique,
            primary,
            index_type: index_type.to_string(),
            column_name: column_name.to_string(),
            key_ordinal,
            descending,
            included,
            comment: comment.to_string(),
        }
    }
}

pub(crate) fn aggregate_index_rows(rows: Vec<SqlServerIndexRow>) -> Vec<IndexInfo> {
    let mut index_map: BTreeMap<String, IndexInfo> = BTreeMap::new();

    for row in rows {
        let col_info = (!row.included && row.key_ordinal > 0).then(|| IndexColumnInfo {
            column_name: row.column_name.clone(),
            seq_in_index: row.key_ordinal,
            collation: Some(if row.descending {
                "D".to_string()
            } else {
                "A".to_string()
            }),
            sub_part: None,
        });

        index_map
            .entry(row.index_name.clone())
            .and_modify(|idx| {
                if let Some(col) = col_info.clone() {
                    idx.columns.push(col);
                }
            })
            .or_insert_with(|| IndexInfo {
                name: row.index_name.clone(),
                unique: row.unique,
                index_type: row.index_type.clone(),
                columns: col_info.into_iter().collect(),
                is_primary: row.primary,
                comment: row.comment.clone(),
            });
    }

    let mut indexes: Vec<IndexInfo> = index_map.into_values().collect();
    for idx in &mut indexes {
        idx.columns.sort_by_key(|c| c.seq_in_index);
    }
    indexes
}

fn list_indexes_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT i.name AS index_name, \
                CAST(i.is_unique AS bit) AS is_unique, \
                CAST(i.is_primary_key AS bit) AS is_primary_key, \
                i.type_desc AS index_type, \
                COALESCE(c.name, N'') AS column_name, \
                CAST(COALESCE(ic.key_ordinal, 0) AS int) AS key_ordinal, \
                CAST(COALESCE(ic.is_descending_key, 0) AS bit) AS is_descending_key, \
                CAST(COALESCE(ic.is_included_column, 0) AS bit) AS is_included_column, \
                COALESCE(CONVERT(nvarchar(4000), ep.value), N'') AS comment \
         FROM sys.indexes i \
         JOIN sys.tables t ON t.object_id = i.object_id \
         JOIN sys.schemas s ON s.schema_id = t.schema_id \
         LEFT JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
         LEFT JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
         LEFT JOIN sys.extended_properties ep \
           ON ep.class = 7 AND ep.major_id = i.object_id AND ep.minor_id = i.index_id AND ep.name = N'MS_Description' \
         WHERE s.name = {} AND t.name = {} \
           AND i.index_id > 0 AND i.is_hypothetical = 0 \
         ORDER BY i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id",
        n_str(schema),
        n_str(table)
    )
}

pub async fn list_indexes(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let mut client = pool
        .get()
        .await
        .map_err(|e| normalize_sqlserver_error("获取连接失败", e.to_string()))?;
    let rows = client
        .simple_query(list_indexes_sql(schema, table))
        .await
        .map_err(|e| normalize_sqlserver_error("查询索引信息失败", e.to_string()))?
        .into_first_result()
        .await
        .map_err(|e| normalize_sqlserver_error("读取索引信息失败", e.to_string()))?;

    let index_rows = rows
        .iter()
        .map(|row| {
            SqlServerIndexRow::new(
                &row_string(row, "index_name"),
                row.get::<bool, _>("is_unique").unwrap_or(false),
                row.get::<bool, _>("is_primary_key").unwrap_or(false),
                &row_string(row, "index_type"),
                &row_string(row, "column_name"),
                row.get::<i32, _>("key_ordinal").unwrap_or(0).max(0) as u32,
                row.get::<bool, _>("is_descending_key").unwrap_or(false),
                row.get::<bool, _>("is_included_column").unwrap_or(false),
                &row_string(row, "comment"),
            )
        })
        .collect();

    Ok(aggregate_index_rows(index_rows))
}

pub async fn create_index(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
    request: &CreateIndexRequest,
) -> Result<(), String> {
    let sql = build_create_index_sql(schema, table, request)?;
    run_sql(pool, "创建索引失败", &sql).await
}

async fn index_is_constraint_backed(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
    index_name: &str,
) -> Result<bool, String> {
    let mut client = pool
        .get()
        .await
        .map_err(|e| normalize_sqlserver_error("获取连接失败", e.to_string()))?;
    let sql = format!(
        "SELECT CAST(CASE WHEN i.is_primary_key = 1 OR i.is_unique_constraint = 1 THEN 1 ELSE 0 END AS bit) AS constraint_backed \
         FROM sys.indexes i \
         JOIN sys.tables t ON t.object_id = i.object_id \
         JOIN sys.schemas s ON s.schema_id = t.schema_id \
         WHERE s.name = {} AND t.name = {} AND i.name = {}",
        n_str(schema),
        n_str(table),
        n_str(index_name)
    );
    let row = client
        .simple_query(sql)
        .await
        .map_err(|e| normalize_sqlserver_error("查询索引信息失败", e.to_string()))?
        .into_row()
        .await
        .map_err(|e| normalize_sqlserver_error("读取索引信息失败", e.to_string()))?;
    let Some(row) = row else {
        return Err(format!("索引 '{}' 不存在", index_name));
    };
    Ok(row.get::<bool, _>("constraint_backed").unwrap_or(false))
}

pub async fn drop_index(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
    index_name: &str,
) -> Result<(), String> {
    let constraint_backed = index_is_constraint_backed(pool, schema, table, index_name).await?;
    let sql = build_drop_index_sql(schema, table, index_name, constraint_backed)?;
    run_sql(pool, "删除索引失败", &sql).await
}

fn normalize_referential_action(rule: &str) -> Result<String, String> {
    match rule.trim().to_uppercase().replace('_', " ").as_str() {
        "NO ACTION" => Ok("NO ACTION".to_string()),
        "CASCADE" => Ok("CASCADE".to_string()),
        "SET NULL" => Ok("SET NULL".to_string()),
        "SET DEFAULT" => Ok("SET DEFAULT".to_string()),
        "RESTRICT" => Err(
            "SQL Server 外键引用动作不支持 RESTRICT，请使用 NO ACTION、CASCADE、SET NULL 或 SET DEFAULT"
                .to_string(),
        ),
        other => Err(format!(
            "无效的引用动作: {}（SQL Server 允许 NO ACTION、CASCADE、SET NULL、SET DEFAULT）",
            other
        )),
    }
}

fn action_desc_to_text(desc: &str) -> String {
    desc.trim().to_uppercase().replace('_', " ")
}

fn parse_qualified_table(default_schema: &str, name: &str) -> Result<(String, String), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("被引用表不能为空".to_string());
    }
    let parts: Vec<&str> = trimmed.split('.').map(str::trim).collect();
    match parts.as_slice() {
        [table] if !table.is_empty() => Ok((default_schema.to_string(), (*table).to_string())),
        [schema, table] if !schema.is_empty() && !table.is_empty() => {
            Ok(((*schema).to_string(), (*table).to_string()))
        }
        [_, _, _] => Err("SQL Server 外键暂不支持跨 database 引用".to_string()),
        _ => Err("被引用表限定名格式无效".to_string()),
    }
}

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

    let (ref_schema, ref_table) = parse_qualified_table(schema, &request.referenced_table)?;
    let on_update = normalize_referential_action(&request.on_update)?;
    let on_delete = normalize_referential_action(&request.on_delete)?;
    let cols: Vec<String> = request
        .columns
        .iter()
        .map(|c| sqlserver_id(c.trim()))
        .collect();
    let ref_cols: Vec<String> = request
        .referenced_columns
        .iter()
        .map(|c| sqlserver_id(c.trim()))
        .collect();

    Ok(format!(
        "ALTER TABLE {}.{} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{} ({}) ON UPDATE {} ON DELETE {}",
        sqlserver_id(schema),
        sqlserver_id(table),
        sqlserver_id(request.constraint_name.trim()),
        cols.join(", "),
        sqlserver_id(&ref_schema),
        sqlserver_id(&ref_table),
        ref_cols.join(", "),
        on_update,
        on_delete
    ))
}

pub fn build_drop_foreign_key_sql(
    schema: &str,
    table: &str,
    constraint_name: &str,
) -> Result<String, String> {
    let name = constraint_name.trim();
    if name.is_empty() {
        return Err("约束名不能为空".to_string());
    }
    Ok(format!(
        "ALTER TABLE {}.{} DROP CONSTRAINT {}",
        sqlserver_id(schema),
        sqlserver_id(table),
        sqlserver_id(name)
    ))
}

#[derive(Debug, Clone)]
pub(crate) struct SqlServerForeignKeyRow {
    pub constraint_name: String,
    pub table_schema: String,
    pub table_name: String,
    pub column_name: String,
    pub referenced_table_schema: String,
    pub referenced_table_name: String,
    pub referenced_column_name: String,
    pub ordinal: u32,
    pub update_rule: String,
    pub delete_rule: String,
}

impl SqlServerForeignKeyRow {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        constraint_name: &str,
        table_schema: &str,
        table_name: &str,
        column_name: &str,
        referenced_table_schema: &str,
        referenced_table_name: &str,
        referenced_column_name: &str,
        ordinal: u32,
        update_rule: &str,
        delete_rule: &str,
    ) -> Self {
        Self {
            constraint_name: constraint_name.to_string(),
            table_schema: table_schema.to_string(),
            table_name: table_name.to_string(),
            column_name: column_name.to_string(),
            referenced_table_schema: referenced_table_schema.to_string(),
            referenced_table_name: referenced_table_name.to_string(),
            referenced_column_name: referenced_column_name.to_string(),
            ordinal,
            update_rule: update_rule.to_string(),
            delete_rule: delete_rule.to_string(),
        }
    }
}

#[derive(Debug, Clone)]
struct ForeignKeyAgg {
    constraint_name: String,
    table_schema: String,
    table_name: String,
    referenced_table_schema: String,
    referenced_table_name: String,
    cols: Vec<(u32, String, String)>,
    update_rule: String,
    delete_rule: String,
}

pub(crate) fn aggregate_foreign_key_rows(
    schema: &str,
    table: &str,
    rows: Vec<SqlServerForeignKeyRow>,
) -> Vec<ForeignKeyInfo> {
    let mut map: BTreeMap<(String, String, String), ForeignKeyAgg> = BTreeMap::new();
    for row in rows {
        let key = (
            row.table_schema.clone(),
            row.table_name.clone(),
            row.constraint_name.clone(),
        );
        map.entry(key)
            .and_modify(|agg| {
                agg.cols.push((
                    row.ordinal,
                    row.column_name.clone(),
                    row.referenced_column_name.clone(),
                ));
            })
            .or_insert_with(|| ForeignKeyAgg {
                constraint_name: row.constraint_name.clone(),
                table_schema: row.table_schema.clone(),
                table_name: row.table_name.clone(),
                referenced_table_schema: row.referenced_table_schema.clone(),
                referenced_table_name: row.referenced_table_name.clone(),
                cols: vec![(
                    row.ordinal,
                    row.column_name.clone(),
                    row.referenced_column_name.clone(),
                )],
                update_rule: action_desc_to_text(&row.update_rule),
                delete_rule: action_desc_to_text(&row.delete_rule),
            });
    }

    let mut result: Vec<ForeignKeyInfo> = map
        .into_values()
        .map(|mut agg| {
            agg.cols.sort_by_key(|(ord, _, _)| *ord);
            let direction = if agg.table_schema == schema && agg.table_name == table {
                "outgoing"
            } else {
                "incoming"
            }
            .to_string();
            ForeignKeyInfo {
                constraint_name: agg.constraint_name,
                direction,
                table_schema: agg.table_schema,
                table_name: agg.table_name,
                column_names: agg.cols.iter().map(|(_, c, _)| c.clone()).collect(),
                referenced_table_schema: agg.referenced_table_schema,
                referenced_table_name: agg.referenced_table_name,
                referenced_column_names: agg.cols.iter().map(|(_, _, c)| c.clone()).collect(),
                update_rule: agg.update_rule,
                delete_rule: agg.delete_rule,
            }
        })
        .collect();

    result.sort_by(|a, b| {
        a.direction
            .cmp(&b.direction)
            .then_with(|| a.constraint_name.cmp(&b.constraint_name))
    });
    result
}

fn list_foreign_keys_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT fk.name AS constraint_name, \
                cs.name AS table_schema, \
                ct.name AS table_name, \
                cc.name AS column_name, \
                rs.name AS referenced_table_schema, \
                rt.name AS referenced_table_name, \
                rc.name AS referenced_column_name, \
                CAST(fkc.constraint_column_id AS int) AS ordinal, \
                fk.update_referential_action_desc AS update_rule, \
                fk.delete_referential_action_desc AS delete_rule \
         FROM sys.foreign_keys fk \
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
         JOIN sys.tables ct ON ct.object_id = fk.parent_object_id \
         JOIN sys.schemas cs ON cs.schema_id = ct.schema_id \
         JOIN sys.columns cc ON cc.object_id = ct.object_id AND cc.column_id = fkc.parent_column_id \
         JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id \
         JOIN sys.schemas rs ON rs.schema_id = rt.schema_id \
         JOIN sys.columns rc ON rc.object_id = rt.object_id AND rc.column_id = fkc.referenced_column_id \
         WHERE (cs.name = {} AND ct.name = {}) OR (rs.name = {} AND rt.name = {}) \
         ORDER BY fk.name, fkc.constraint_column_id",
        n_str(schema),
        n_str(table),
        n_str(schema),
        n_str(table)
    )
}

pub async fn list_foreign_keys(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let mut client = pool
        .get()
        .await
        .map_err(|e| normalize_sqlserver_error("获取连接失败", e.to_string()))?;
    let rows = client
        .simple_query(list_foreign_keys_sql(schema, table))
        .await
        .map_err(|e| normalize_sqlserver_error("查询外键信息失败", e.to_string()))?
        .into_first_result()
        .await
        .map_err(|e| normalize_sqlserver_error("读取外键信息失败", e.to_string()))?;

    let fk_rows = rows
        .iter()
        .map(|row| {
            SqlServerForeignKeyRow::new(
                &row_string(row, "constraint_name"),
                &row_string(row, "table_schema"),
                &row_string(row, "table_name"),
                &row_string(row, "column_name"),
                &row_string(row, "referenced_table_schema"),
                &row_string(row, "referenced_table_name"),
                &row_string(row, "referenced_column_name"),
                row.get::<i32, _>("ordinal").unwrap_or(0).max(0) as u32,
                &row_string(row, "update_rule"),
                &row_string(row, "delete_rule"),
            )
        })
        .collect();

    Ok(aggregate_foreign_key_rows(schema, table, fk_rows))
}

pub async fn add_foreign_key(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
    request: &AddForeignKeyRequest,
) -> Result<(), String> {
    let sql = build_add_foreign_key_sql(schema, table, request)?;
    run_sql(pool, "添加外键失败", &sql).await
}

pub async fn drop_foreign_key(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
    constraint_name: &str,
) -> Result<(), String> {
    let sql = build_drop_foreign_key_sql(schema, table, constraint_name)?;
    run_sql(pool, "删除外键失败", &sql).await
}

fn normalize_trigger_event(event: &str) -> String {
    let upper = event.trim().to_uppercase();
    upper
        .strip_prefix("DML_")
        .unwrap_or(&upper)
        .replace('_', " ")
}

#[derive(Debug, Clone)]
struct SqlServerTriggerRow {
    name: String,
    table_name: String,
    event: String,
    instead_of: bool,
    statement: String,
    created: Option<String>,
    definer: String,
}

fn aggregate_trigger_rows(rows: Vec<SqlServerTriggerRow>) -> Vec<TriggerInfo> {
    let mut map: BTreeMap<(String, String), TriggerInfo> = BTreeMap::new();
    for row in rows {
        let event = normalize_trigger_event(&row.event);
        let key = (row.table_name.clone(), row.name.clone());
        map.entry(key)
            .and_modify(|trigger| {
                if !trigger.event.split(" OR ").any(|e| e == event) {
                    trigger.event.push_str(" OR ");
                    trigger.event.push_str(&event);
                }
            })
            .or_insert_with(|| TriggerInfo {
                name: row.name.clone(),
                event,
                timing: if row.instead_of {
                    "INSTEAD OF".to_string()
                } else {
                    "AFTER".to_string()
                },
                table_name: row.table_name.clone(),
                statement: row.statement.clone(),
                created: row.created.clone(),
                sql_mode: String::new(),
                definer: row.definer.clone(),
            });
    }
    map.into_values().collect()
}

fn list_triggers_sql(schema: &str, table: Option<&str>) -> String {
    let table_filter = table
        .map(|t| format!(" AND parent.name = {}", n_str(t)))
        .unwrap_or_default();
    format!(
        "SELECT tr.name AS trigger_name, \
                parent.name AS table_name, \
                COALESCE(ev.type_desc, N'') AS event_name, \
                CAST(OBJECTPROPERTYEX(tr.object_id, 'ExecIsInsteadOfTrigger') AS bit) AS is_instead_of, \
                COALESCE(m.definition, N'') AS definition, \
                CONVERT(varchar(19), tr.create_date, 120) AS created_at, \
                COALESCE(USER_NAME(tr.principal_id), N'') AS definer \
         FROM sys.triggers tr \
         JOIN sys.tables parent ON parent.object_id = tr.parent_id \
         JOIN sys.schemas s ON s.schema_id = parent.schema_id \
         LEFT JOIN sys.trigger_events ev ON ev.object_id = tr.object_id \
         LEFT JOIN sys.sql_modules m ON m.object_id = tr.object_id \
         WHERE tr.parent_class = 1 AND tr.is_ms_shipped = 0 AND s.name = {}{} \
         ORDER BY parent.name, tr.name, ev.type_desc",
        n_str(schema),
        table_filter
    )
}

pub async fn list_triggers(
    pool: &SqlServerPool,
    schema: &str,
    table: Option<&str>,
) -> Result<Vec<TriggerInfo>, String> {
    let mut client = pool
        .get()
        .await
        .map_err(|e| normalize_sqlserver_error("获取连接失败", e.to_string()))?;
    let rows = client
        .simple_query(list_triggers_sql(schema, table))
        .await
        .map_err(|e| normalize_sqlserver_error("查询触发器列表失败", e.to_string()))?
        .into_first_result()
        .await
        .map_err(|e| normalize_sqlserver_error("读取触发器列表失败", e.to_string()))?;

    let trigger_rows = rows
        .iter()
        .map(|row| SqlServerTriggerRow {
            name: row_string(row, "trigger_name"),
            table_name: row_string(row, "table_name"),
            event: row_string(row, "event_name"),
            instead_of: row.get::<bool, _>("is_instead_of").unwrap_or(false),
            statement: row_string(row, "definition"),
            created: row_opt_string(row, "created_at"),
            definer: row_string(row, "definer"),
        })
        .collect();
    Ok(aggregate_trigger_rows(trigger_rows))
}

fn trigger_definition_sql(schema: &str, table: Option<&str>, trigger_name: &str) -> String {
    let table_filter = table
        .map(|t| format!(" AND parent.name = {}", n_str(t)))
        .unwrap_or_default();
    format!(
        "SELECT TOP (1) m.definition AS definition \
         FROM sys.triggers tr \
         JOIN sys.tables parent ON parent.object_id = tr.parent_id \
         JOIN sys.schemas s ON s.schema_id = parent.schema_id \
         JOIN sys.sql_modules m ON m.object_id = tr.object_id \
         WHERE tr.parent_class = 1 AND tr.is_ms_shipped = 0 \
           AND s.name = {}{} AND tr.name = {}",
        n_str(schema),
        table_filter,
        n_str(trigger_name)
    )
}

pub async fn get_trigger_definition(
    pool: &SqlServerPool,
    schema: &str,
    table: Option<&str>,
    trigger_name: &str,
) -> Result<String, String> {
    if trigger_name.trim().is_empty() {
        return Err("触发器名称不能为空".to_string());
    }
    let mut client = pool
        .get()
        .await
        .map_err(|e| normalize_sqlserver_error("获取连接失败", e.to_string()))?;
    let row = client
        .simple_query(trigger_definition_sql(schema, table, trigger_name.trim()))
        .await
        .map_err(|e| normalize_sqlserver_error("查询触发器定义失败", e.to_string()))?
        .into_row()
        .await
        .map_err(|e| normalize_sqlserver_error("读取触发器定义失败", e.to_string()))?;
    row.and_then(|r| r.get::<&str, _>("definition").map(str::to_string))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("触发器 '{}' 不存在", trigger_name.trim()))
}

pub fn build_create_trigger_sql(
    schema: &str,
    table: &str,
    request: &CreateTriggerRequest,
) -> Result<String, String> {
    if request.name.trim().is_empty() {
        return Err("触发器名称不能为空".to_string());
    }
    if request.body.trim().is_empty() {
        return Err("触发器语句体不能为空".to_string());
    }

    let timing = request.timing.trim().to_uppercase();
    match timing.as_str() {
        "AFTER" => {}
        "INSTEAD OF" => {
            return Err(
                "SQL Server 当前入口暂不支持 INSTEAD OF 触发器，请使用 SQL 编辑器创建".to_string(),
            );
        }
        _ => return Err("SQL Server 触发器创建入口仅支持 AFTER".to_string()),
    }

    let event = request.event.trim().to_uppercase();
    match event.as_str() {
        "INSERT" | "UPDATE" | "DELETE" => {}
        _ => return Err("触发器事件必须为 INSERT、UPDATE 或 DELETE".to_string()),
    }

    let body = request.body.trim();
    let body_sql = if body.to_uppercase().starts_with("BEGIN") {
        body.to_string()
    } else {
        format!("BEGIN\n  SET NOCOUNT ON;\n  {}\nEND", body)
    };

    Ok(format!(
        "CREATE TRIGGER {}.{} ON {}.{}\nAFTER {}\nAS\n{}",
        sqlserver_id(schema),
        sqlserver_id(request.name.trim()),
        sqlserver_id(schema),
        sqlserver_id(table),
        event,
        body_sql
    ))
}

pub async fn create_trigger(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
    request: &CreateTriggerRequest,
) -> Result<(), String> {
    let sql = build_create_trigger_sql(schema, table, request)?;
    run_sql(pool, "创建触发器失败", &sql).await
}

pub async fn drop_trigger(
    pool: &SqlServerPool,
    schema: &str,
    trigger_name: &str,
) -> Result<(), String> {
    let name = trigger_name.trim();
    if name.is_empty() {
        return Err("触发器名称不能为空".to_string());
    }
    let sql = format!(
        "DROP TRIGGER {}.{}",
        sqlserver_id(schema),
        sqlserver_id(name)
    );
    run_sql(pool, "删除触发器失败", &sql).await
}

pub fn routine_type_from_sqlserver_type(object_type: &str) -> Result<&'static str, String> {
    let t = object_type.trim().to_uppercase();
    if SQLSERVER_ROUTINE_PROCEDURE_TYPES.contains(&t.as_str()) {
        Ok("PROCEDURE")
    } else if SQLSERVER_ROUTINE_FUNCTION_TYPES.contains(&t.as_str()) {
        Ok("FUNCTION")
    } else {
        Err(format!("不支持的 SQL Server 例程类型: {}", object_type))
    }
}

fn routine_type_filter_clause(routine_type: Option<&str>) -> Result<String, String> {
    match routine_type.map(str::trim).filter(|s| !s.is_empty()) {
        Some(t) if t.eq_ignore_ascii_case("PROCEDURE") => {
            Ok(" AND o.type IN ('P', 'PC')".to_string())
        }
        Some(t) if t.eq_ignore_ascii_case("FUNCTION") => {
            Ok(" AND o.type IN ('FN', 'IF', 'TF', 'FS', 'FT')".to_string())
        }
        Some(t) => Err(format!(
            "routine_type 仅支持 PROCEDURE、FUNCTION 或留空，收到: {}",
            t
        )),
        None => Ok(String::new()),
    }
}

fn list_routines_sql(schema: &str, routine_type: Option<&str>) -> Result<String, String> {
    let filter = routine_type_filter_clause(routine_type)?;
    Ok(format!(
        "SELECT o.name AS routine_name, \
                o.type AS object_type, \
                CASE WHEN o.type IN ('IF', 'TF', 'FT') THEN N'TABLE' \
                     WHEN o.type IN ('FN', 'FS') THEN COALESCE(rt.name, N'') \
                     ELSE NULL END AS data_type, \
                COALESCE(USER_NAME(o.principal_id), N'') AS definer, \
                COALESCE(CONVERT(nvarchar(4000), ep.value), N'') AS routine_comment, \
                CONVERT(varchar(19), o.create_date, 120) AS created_at, \
                CONVERT(varchar(19), o.modify_date, 120) AS last_altered \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         LEFT JOIN sys.parameters ret ON ret.object_id = o.object_id AND ret.parameter_id = 0 \
         LEFT JOIN sys.types rt ON rt.user_type_id = ret.user_type_id \
         LEFT JOIN sys.extended_properties ep \
           ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description' \
         WHERE s.name = {} AND o.is_ms_shipped = 0 \
           AND o.type IN ('P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT'){} \
         ORDER BY CASE WHEN o.type IN ('P', 'PC') THEN 0 ELSE 1 END, o.name",
        n_str(schema),
        filter
    ))
}

pub async fn list_routines(
    pool: &SqlServerPool,
    schema: &str,
    routine_type: Option<&str>,
) -> Result<Vec<RoutineInfo>, String> {
    let sql = list_routines_sql(schema, routine_type)?;
    let mut client = pool
        .get()
        .await
        .map_err(|e| normalize_sqlserver_error("获取连接失败", e.to_string()))?;
    let rows = client
        .simple_query(sql)
        .await
        .map_err(|e| normalize_sqlserver_error("查询例程列表失败", e.to_string()))?
        .into_first_result()
        .await
        .map_err(|e| normalize_sqlserver_error("读取例程列表失败", e.to_string()))?;

    rows.iter()
        .map(|row| {
            let object_type = row_string(row, "object_type");
            let routine_type = routine_type_from_sqlserver_type(&object_type)?.to_string();
            Ok(RoutineInfo {
                name: row_string(row, "routine_name"),
                routine_type,
                data_type: row_opt_string(row, "data_type"),
                definer: row_string(row, "definer"),
                security_type: String::new(),
                routine_comment: row_string(row, "routine_comment"),
                created: row_opt_string(row, "created_at"),
                last_altered: row_opt_string(row, "last_altered"),
                identity_arguments: None,
            })
        })
        .collect()
}

fn routine_definition_sql(
    schema: &str,
    routine_name: &str,
    routine_type: &str,
) -> Result<String, String> {
    let filter = routine_type_filter_clause(Some(routine_type))?;
    Ok(format!(
        "SELECT TOP (1) OBJECT_DEFINITION(o.object_id) AS definition \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = {} AND o.name = {}{}",
        n_str(schema),
        n_str(routine_name),
        filter
    ))
}

pub async fn get_routine_definition(
    pool: &SqlServerPool,
    schema: &str,
    routine_name: &str,
    routine_type: &str,
) -> Result<String, String> {
    if routine_name.trim().is_empty() {
        return Err("例程名称不能为空".to_string());
    }
    let sql = routine_definition_sql(schema, routine_name.trim(), routine_type)?;
    let mut client = pool
        .get()
        .await
        .map_err(|e| normalize_sqlserver_error("获取连接失败", e.to_string()))?;
    let row = client
        .simple_query(sql)
        .await
        .map_err(|e| normalize_sqlserver_error("获取例程定义失败", e.to_string()))?
        .into_row()
        .await
        .map_err(|e| normalize_sqlserver_error("读取例程定义失败", e.to_string()))?;
    row.and_then(|r| r.get::<&str, _>("definition").map(str::to_string))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("例程 '{}' 不存在", routine_name.trim()))
}

pub fn sqlserver_events_unsupported() -> &'static str {
    "SQL Server 暂不支持 EVENT；请使用 SQL Server Agent 或 SQL 编辑器中的作业管理方式"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{
        AddForeignKeyRequest, CreateIndexColumn, CreateIndexRequest, CreateTriggerRequest,
    };

    #[test]
    fn build_create_index_sql_supports_normal_unique_and_order() {
        let req = CreateIndexRequest {
            index_name: "idx_orders_user".to_string(),
            index_type: "UNIQUE".to_string(),
            index_method: None,
            columns: vec![
                CreateIndexColumn {
                    column_name: "user_id".to_string(),
                    length: None,
                    order: Some("DESC".to_string()),
                },
                CreateIndexColumn {
                    column_name: "created_at".to_string(),
                    length: Some(10),
                    order: Some("ASC".to_string()),
                },
            ],
            comment: Some("ignored".to_string()),
        };

        let sql = build_create_index_sql("dbo", "orders", &req).unwrap();

        assert_eq!(
            sql,
            "CREATE UNIQUE INDEX [idx_orders_user] ON [dbo].[orders] ([user_id] DESC, [created_at] ASC)"
        );
    }

    #[test]
    fn build_create_index_sql_rejects_unsupported_sqlserver_types() {
        let req = CreateIndexRequest {
            index_name: "idx_body".to_string(),
            index_type: "FULLTEXT".to_string(),
            index_method: None,
            columns: vec![CreateIndexColumn {
                column_name: "body".to_string(),
                length: None,
                order: None,
            }],
            comment: None,
        };

        let err = build_create_index_sql("dbo", "docs", &req).unwrap_err();
        assert!(err.contains("SQL Server 暂不支持"));
    }

    #[test]
    fn build_drop_index_sql_uses_sqlserver_syntax() {
        assert_eq!(
            build_drop_index_sql("dbo", "orders", "idx_orders_user", false).unwrap(),
            "DROP INDEX [idx_orders_user] ON [dbo].[orders]"
        );
        assert_eq!(
            build_drop_index_sql("dbo", "orders", "PK_orders", true).unwrap(),
            "ALTER TABLE [dbo].[orders] DROP CONSTRAINT [PK_orders]"
        );
    }

    #[test]
    fn aggregate_index_rows_orders_key_columns_and_ignores_included_columns() {
        let rows = vec![
            SqlServerIndexRow::new(
                "idx_orders_user",
                false,
                false,
                "NONCLUSTERED",
                "included_col",
                0,
                false,
                true,
                "",
            ),
            SqlServerIndexRow::new(
                "idx_orders_user",
                false,
                false,
                "NONCLUSTERED",
                "created_at",
                2,
                true,
                false,
                "",
            ),
            SqlServerIndexRow::new(
                "idx_orders_user",
                false,
                false,
                "NONCLUSTERED",
                "user_id",
                1,
                false,
                false,
                "",
            ),
        ];

        let indexes = aggregate_index_rows(rows);

        assert_eq!(indexes.len(), 1);
        assert_eq!(indexes[0].columns.len(), 2);
        assert_eq!(indexes[0].columns[0].column_name, "user_id");
        assert_eq!(indexes[0].columns[1].column_name, "created_at");
        assert_eq!(indexes[0].columns[1].collation.as_deref(), Some("D"));
    }

    #[test]
    fn build_add_foreign_key_sql_allows_only_sqlserver_actions() {
        let req = AddForeignKeyRequest {
            constraint_name: "fk_orders_user".to_string(),
            columns: vec!["user_id".to_string()],
            referenced_table: "users".to_string(),
            referenced_columns: vec!["id".to_string()],
            on_update: "NO ACTION".to_string(),
            on_delete: "CASCADE".to_string(),
        };

        assert_eq!(
            build_add_foreign_key_sql("dbo", "orders", &req).unwrap(),
            "ALTER TABLE [dbo].[orders] ADD CONSTRAINT [fk_orders_user] FOREIGN KEY ([user_id]) REFERENCES [dbo].[users] ([id]) ON UPDATE NO ACTION ON DELETE CASCADE"
        );

        let mut bad = req;
        bad.on_update = "RESTRICT".to_string();
        assert!(build_add_foreign_key_sql("dbo", "orders", &bad).is_err());
    }

    #[test]
    fn build_add_foreign_key_sql_rejects_cross_database_names() {
        let req = AddForeignKeyRequest {
            constraint_name: "fk_x".to_string(),
            columns: vec!["a".to_string()],
            referenced_table: "otherdb.dbo.users".to_string(),
            referenced_columns: vec!["id".to_string()],
            on_update: "NO ACTION".to_string(),
            on_delete: "NO ACTION".to_string(),
        };

        let err = build_add_foreign_key_sql("dbo", "orders", &req).unwrap_err();
        assert!(err.contains("跨 database"));
    }

    #[test]
    fn build_drop_foreign_key_sql_uses_drop_constraint() {
        assert_eq!(
            build_drop_foreign_key_sql("dbo", "orders", "fk_orders_user").unwrap(),
            "ALTER TABLE [dbo].[orders] DROP CONSTRAINT [fk_orders_user]"
        );
    }

    #[test]
    fn aggregate_foreign_key_rows_preserves_column_order_and_direction() {
        let rows = vec![
            SqlServerForeignKeyRow::new(
                "fk_orders_user",
                "dbo",
                "orders",
                "user_id2",
                "dbo",
                "users",
                "id2",
                2,
                "NO_ACTION",
                "CASCADE",
            ),
            SqlServerForeignKeyRow::new(
                "fk_orders_user",
                "dbo",
                "orders",
                "user_id",
                "dbo",
                "users",
                "id",
                1,
                "NO_ACTION",
                "CASCADE",
            ),
        ];

        let fks = aggregate_foreign_key_rows("dbo", "orders", rows);

        assert_eq!(fks.len(), 1);
        assert_eq!(fks[0].direction, "outgoing");
        assert_eq!(fks[0].column_names, vec!["user_id", "user_id2"]);
        assert_eq!(fks[0].referenced_column_names, vec!["id", "id2"]);
        assert_eq!(fks[0].update_rule, "NO ACTION");
    }

    #[test]
    fn build_create_trigger_sql_supports_after_only() {
        let req = CreateTriggerRequest {
            name: "trg_orders_ai".to_string(),
            timing: "AFTER".to_string(),
            event: "INSERT".to_string(),
            body: "INSERT INTO audit_log(action_name) VALUES ('insert');".to_string(),
        };

        let sql = build_create_trigger_sql("dbo", "orders", &req).unwrap();

        assert!(sql.contains("CREATE TRIGGER [dbo].[trg_orders_ai] ON [dbo].[orders]"));
        assert!(sql.contains("AFTER INSERT"));
        assert!(sql.contains("SET NOCOUNT ON;"));
        assert!(sql.contains("INSERT INTO audit_log"));
    }

    #[test]
    fn build_create_trigger_sql_rejects_before_and_instead_of() {
        let req = CreateTriggerRequest {
            name: "trg_orders_bi".to_string(),
            timing: "BEFORE".to_string(),
            event: "INSERT".to_string(),
            body: "SELECT 1;".to_string(),
        };
        assert!(build_create_trigger_sql("dbo", "orders", &req).is_err());

        let req = CreateTriggerRequest {
            timing: "INSTEAD OF".to_string(),
            ..req
        };
        assert!(build_create_trigger_sql("dbo", "orders", &req).is_err());
    }

    #[test]
    fn routine_type_maps_sqlserver_object_types() {
        assert_eq!(routine_type_from_sqlserver_type("P").unwrap(), "PROCEDURE");
        assert_eq!(routine_type_from_sqlserver_type("FN").unwrap(), "FUNCTION");
        assert_eq!(routine_type_from_sqlserver_type("IF").unwrap(), "FUNCTION");
        assert_eq!(routine_type_from_sqlserver_type("TF").unwrap(), "FUNCTION");
        assert!(routine_type_from_sqlserver_type("V").is_err());
    }

    #[test]
    fn event_operations_return_unsupported_message() {
        assert!(sqlserver_events_unsupported().contains("SQL Server 暂不支持 EVENT"));
    }
}
