use std::collections::BTreeMap;

use deadpool_sqlite::Pool;

use crate::db::schema_compare::{compare_table_columns, TableSnapshot};
use crate::db::sql_utils::{sqlite_id, sqlite_str};
use crate::db::sqlite::{build_add_column_sql, build_create_table_sql};
use crate::models::types::{
    AddColumnRequest, CreateTableColumnDef, CreateTableRequest, DatabaseSyncOperationKind,
    DatabaseSyncRisk, SchemaDiffStatus,
};

use super::{
    add_column_risk, ColumnSyncMetadata, OperationPhase, PlanFragments, TablePlanContext,
    TableSyncMetadata,
};

pub(crate) fn metadata_sql(schema: &str) -> String {
    format!(
        "SELECT objects.name AS table_name, COALESCE(objects.sql, '') AS create_sql, \
                columns.name AS column_name, columns.hidden, \
                columns.pk AS primary_key_ordinal \
         FROM {}.sqlite_schema objects \
         JOIN pragma_table_list table_list \
           ON table_list.schema = {} \
          AND table_list.name = objects.name \
          AND table_list.type = 'table' \
         JOIN pragma_table_xinfo(objects.name, {}) columns \
         WHERE objects.type = 'table' AND lower(objects.name) NOT GLOB 'sqlite_*' \
         ORDER BY objects.name, columns.cid",
        sqlite_id(schema),
        sqlite_str(schema),
        sqlite_str(schema)
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MetadataRow {
    table_name: String,
    create_sql: String,
    column_name: String,
    hidden: i64,
    primary_key_ordinal: Option<u32>,
}

fn aggregate_metadata_rows(rows: Vec<MetadataRow>) -> BTreeMap<String, TableSyncMetadata> {
    let mut metadata = BTreeMap::new();
    for row in rows {
        let entry = metadata
            .entry(row.table_name)
            .or_insert_with(|| TableSyncMetadata::Sqlite {
                create_sql: row.create_sql,
                columns: BTreeMap::new(),
            });
        let TableSyncMetadata::Sqlite { columns, .. } = entry else {
            unreachable!("SQLite 元数据映射只能创建 Sqlite 变体");
        };
        columns.insert(
            row.column_name,
            ColumnSyncMetadata::Sqlite {
                hidden: row.hidden,
                primary_key_ordinal: row.primary_key_ordinal,
            },
        );
    }
    metadata
}

#[allow(dead_code, reason = "将在后续统一同步元数据分发中调用")]
pub(crate) async fn load_metadata(
    pool: &Pool,
    schema: &str,
) -> Result<BTreeMap<String, TableSyncMetadata>, String> {
    let conn = pool
        .get()
        .await
        .map_err(|error| format!("获取 SQLite 同步元数据连接失败: {error}"))?;
    let sql = metadata_sql(schema);
    conn.interact(move |conn| {
        let mut statement = conn
            .prepare(&sql)
            .map_err(|error| format!("查询 SQLite 同步表元数据失败: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(MetadataRow {
                    table_name: row.get("table_name")?,
                    create_sql: row.get("create_sql")?,
                    column_name: row.get("column_name")?,
                    hidden: row.get("hidden")?,
                    primary_key_ordinal: row
                        .get::<_, i64>("primary_key_ordinal")
                        .ok()
                        .and_then(|value| u32::try_from(value).ok())
                        .filter(|value| *value > 0),
                })
            })
            .map_err(|error| format!("查询 SQLite 同步表元数据失败: {error}"))?;
        let mapped = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("查询 SQLite 同步表元数据失败: {error}"))?;
        Ok(aggregate_metadata_rows(mapped))
    })
    .await
    .map_err(|error| format!("SQLite 同步元数据查询任务失败: {error}"))?
}

#[allow(dead_code, reason = "将在后续统一同步计划分发中调用")]
pub(crate) fn plan_table(context: TablePlanContext<'_>) -> PlanFragments {
    let mut plan = PlanFragments::default();
    match (context.source, context.target) {
        (Some(source), None) => plan_create_table(&mut plan, &context, source),
        (None, Some(target)) => plan_target_only_table(&mut plan, &context, target),
        (Some(source), Some(target)) => plan_changed_table(&mut plan, &context, source, target),
        (None, None) => plan.block("", "无法规划同步", "表在源端和目标端都不存在"),
    }
    plan
}

fn plan_target_only_table(
    plan: &mut PlanFragments,
    context: &TablePlanContext<'_>,
    target: &TableSnapshot,
) {
    let metadata = match table_metadata(context.target_metadata, &target.name) {
        Ok(metadata) => metadata,
        Err(reason) => {
            plan.block(
                &target.name,
                &format!("无法删除表 {}", target.name),
                &reason,
            );
            return;
        }
    };
    if let Err(reason) = validate_physical_table(metadata) {
        plan.block(
            &target.name,
            &format!("无法删除表 {}", target.name),
            &reason,
        );
        return;
    }
    if context.include_drops {
        plan.operation(
            OperationPhase::DropTable,
            &target.name,
            DatabaseSyncOperationKind::DropTable,
            DatabaseSyncRisk::Destructive,
            &format!("删除目标端独有表 {}", target.name),
            vec![format!(
                "DROP TABLE {}.{}",
                sqlite_id(context.target_database),
                sqlite_id(&target.name)
            )],
        );
    } else {
        plan.skip(&target.name, "跳过删除目标端独有表", "未开启包含删除操作");
    }
}

#[derive(Clone, Copy)]
struct SqliteTableMetadataRef<'a> {
    create_sql: &'a str,
    columns: &'a BTreeMap<String, ColumnSyncMetadata>,
}

fn table_metadata<'a>(
    metadata: Option<&'a TableSyncMetadata>,
    table_name: &str,
) -> Result<SqliteTableMetadataRef<'a>, String> {
    let Some(TableSyncMetadata::Sqlite {
        create_sql,
        columns,
    }) = metadata
    else {
        return Err(format!("表 {table_name} 缺少 SQLite 原生表元数据"));
    };
    Ok(SqliteTableMetadataRef {
        create_sql,
        columns,
    })
}

fn column_hidden(
    metadata: SqliteTableMetadataRef<'_>,
    table_name: &str,
    column_name: &str,
) -> Result<i64, String> {
    let Some(ColumnSyncMetadata::Sqlite { hidden, .. }) = metadata.columns.get(column_name) else {
        return Err(format!(
            "字段 {table_name}.{column_name} 缺少 SQLite 原生 hidden 元数据"
        ));
    };
    Ok(*hidden)
}

fn sqlite_primary_key_columns(
    table: &TableSnapshot,
    metadata: SqliteTableMetadataRef<'_>,
) -> Result<Vec<String>, String> {
    let mut ordered = Vec::new();
    let mut ordinals = std::collections::BTreeSet::new();
    for (name, column) in &table.columns {
        let Some(ColumnSyncMetadata::Sqlite {
            primary_key_ordinal,
            ..
        }) = metadata.columns.get(name)
        else {
            return Err(format!(
                "字段 {}.{} 缺少 SQLite 原生主键序号元数据",
                table.name, name
            ));
        };
        match (column.primary_key, primary_key_ordinal) {
            (true, Some(ordinal)) => {
                if !ordinals.insert(*ordinal) {
                    return Err(format!(
                        "复合主键表 {} 包含重复的 SQLite 原生主键序号",
                        table.name
                    ));
                }
                ordered.push((*ordinal, name.clone()));
            }
            (true, None) => {
                return Err(format!(
                    "主键字段 {}.{} 缺少 SQLite 原生主键序号",
                    table.name, name
                ));
            }
            (false, Some(_)) => {
                return Err(format!(
                    "字段 {}.{} 的主键标志与 SQLite 原生主键序号不一致",
                    table.name, name
                ));
            }
            (false, None) => {}
        }
    }
    ordered.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    if ordered
        .iter()
        .enumerate()
        .any(|(index, (ordinal, _))| *ordinal as usize != index + 1)
    {
        return Err(format!("表 {} 的 SQLite 原生主键序号不连续", table.name));
    }
    Ok(ordered.into_iter().map(|(_, name)| name).collect())
}

fn validate_plain_table(metadata: SqliteTableMetadataRef<'_>) -> Result<(), String> {
    validate_physical_table(metadata)?;
    let create_sql = metadata.create_sql.trim().trim_end_matches(';').trim();
    if contains_unquoted_keyword(create_sql, "AUTOINCREMENT") {
        return Err(
            "SQLite 原始建表声明包含 AUTOINCREMENT，无法由结构化 builder 无损重建".to_string(),
        );
    }
    let Some((_, suffix)) = create_sql.rsplit_once(')') else {
        return Err("SQLite 原始建表声明缺少完整字段列表".to_string());
    };
    if !suffix.trim().is_empty() {
        return Err(format!(
            "SQLite 表选项 `{}` 无法由普通建表 builder 无损表达",
            suffix.trim()
        ));
    }
    Ok(())
}

fn contains_unquoted_keyword(sql: &str, keyword: &str) -> bool {
    let bytes = sql.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' | b'`' => {
                let quote = bytes[index];
                index += 1;
                while index < bytes.len() {
                    if bytes[index] == quote {
                        if bytes.get(index + 1) == Some(&quote) {
                            index += 2;
                            continue;
                        }
                        index += 1;
                        break;
                    }
                    index += 1;
                }
            }
            b'[' => {
                index += 1;
                while index < bytes.len() {
                    if bytes[index] == b']' {
                        index += 1;
                        break;
                    }
                    index += 1;
                }
            }
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                index += 2;
                while index < bytes.len() && !matches!(bytes[index], b'\r' | b'\n') {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index += 2;
                while index + 1 < bytes.len() {
                    if bytes[index] == b'*' && bytes[index + 1] == b'/' {
                        index += 2;
                        break;
                    }
                    index += 1;
                }
            }
            byte if byte.is_ascii_alphabetic() || byte == b'_' => {
                let start = index;
                index += 1;
                while bytes
                    .get(index)
                    .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
                {
                    index += 1;
                }
                if sql[start..index].eq_ignore_ascii_case(keyword) {
                    return true;
                }
            }
            _ => index += 1,
        }
    }
    false
}

pub(super) fn native_table_signature(create_sql: &str) -> (bool, String) {
    let suffix = create_sql
        .trim()
        .trim_end_matches(';')
        .trim()
        .rsplit_once(')')
        .map(|(_, suffix)| {
            suffix
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_ascii_uppercase()
        })
        .unwrap_or_default();
    (
        contains_unquoted_keyword(create_sql, "AUTOINCREMENT"),
        suffix,
    )
}

fn validate_physical_table(metadata: SqliteTableMetadataRef<'_>) -> Result<(), String> {
    let create_sql = metadata.create_sql.trim().trim_end_matches(';').trim();
    if create_sql.is_empty() {
        return Err("SQLite 原始建表声明为空，无法确认表形态".to_string());
    }
    let upper = create_sql.to_ascii_uppercase();
    if upper.starts_with("CREATE VIRTUAL TABLE") {
        return Err("SQLite 虚拟表不在首期物理表同步范围内".to_string());
    }
    if !upper.starts_with("CREATE TABLE") {
        return Err("SQLite 原始建表声明不是普通 CREATE TABLE".to_string());
    }
    Ok(())
}

fn plan_create_table(
    plan: &mut PlanFragments,
    context: &TablePlanContext<'_>,
    source: &TableSnapshot,
) {
    let metadata = match table_metadata(context.source_metadata, &source.name) {
        Ok(metadata) => metadata,
        Err(reason) => {
            plan.block(
                &source.name,
                &format!("无法创建表 {}", source.name),
                &reason,
            );
            return;
        }
    };
    if let Err(reason) = validate_plain_table(metadata) {
        plan.block(
            &source.name,
            &format!("无法创建表 {}", source.name),
            &reason,
        );
        return;
    }
    if source.columns.is_empty() {
        plan.block(
            &source.name,
            &format!("无法创建表 {}", source.name),
            "源表没有字段",
        );
        return;
    }

    let mut columns = source.columns.iter().collect::<Vec<_>>();
    columns.sort_by(|left, right| {
        left.1
            .ordinal_position
            .cmp(&right.1.ordinal_position)
            .then_with(|| left.0.cmp(&right.0))
    });
    let mut definitions = Vec::with_capacity(columns.len());
    for (name, column) in columns {
        let hidden = match column_hidden(metadata, &source.name, name) {
            Ok(hidden) => hidden,
            Err(reason) => {
                plan.block(
                    &source.name,
                    &format!("无法创建字段 {}.{}", source.name, name),
                    &reason,
                );
                continue;
            }
        };
        if hidden != 0 || !column.extra.trim().is_empty() {
            plan.block(
                &source.name,
                &format!("无法创建字段 {}.{}", source.name, name),
                "SQLite generated/auto_increment 字段无法由结构化 builder 无损重建",
            );
            continue;
        }
        let default_value = match normalize_default_for_builder(column.default_value.as_deref()) {
            Ok(default_value) => default_value.value,
            Err(reason) => {
                plan.block(
                    &source.name,
                    &format!("无法创建字段 {}.{}", source.name, name),
                    &reason,
                );
                continue;
            }
        };
        definitions.push(CreateTableColumnDef {
            name: name.clone(),
            column_type: column.column_type.clone(),
            nullable: column.nullable,
            default_value,
            extra: String::new(),
            comment: String::new(),
        });
    }
    if !plan.blockers.is_empty() {
        return;
    }

    let primary_keys = match sqlite_primary_key_columns(source, metadata) {
        Ok(primary_keys) => primary_keys,
        Err(reason) => {
            plan.block(
                &source.name,
                &format!("无法创建表 {}", source.name),
                &reason,
            );
            return;
        }
    };
    let request = CreateTableRequest {
        table_name: source.name.clone(),
        columns: definitions,
        primary_keys,
        engine: String::new(),
        order_by: None,
        comment: String::new(),
    };
    match build_create_table_sql(context.target_database, &request) {
        Ok(sql) => plan.operation(
            OperationPhase::CreateTable,
            &source.name,
            DatabaseSyncOperationKind::CreateTable,
            DatabaseSyncRisk::Normal,
            &format!("创建目标端表 {}", source.name),
            vec![sql],
        ),
        Err(reason) => plan.block(
            &source.name,
            &format!("无法创建表 {}", source.name),
            &reason,
        ),
    }
}

fn plan_changed_table(
    plan: &mut PlanFragments,
    context: &TablePlanContext<'_>,
    source: &TableSnapshot,
    target: &TableSnapshot,
) {
    let source_metadata = match table_metadata(context.source_metadata, &source.name) {
        Ok(metadata) => metadata,
        Err(reason) => {
            plan.block(&source.name, "无法规划 SQLite 表同步", &reason);
            return;
        }
    };
    let target_metadata = match table_metadata(context.target_metadata, &target.name) {
        Ok(metadata) => metadata,
        Err(reason) => {
            plan.block(&source.name, "无法规划 SQLite 表同步", &reason);
            return;
        }
    };
    if let Err(reason) = validate_physical_table(source_metadata) {
        plan.block(&source.name, "无法规划 SQLite 表同步", &reason);
        return;
    }
    if let Err(reason) = validate_physical_table(target_metadata) {
        plan.block(&source.name, "无法规划 SQLite 表同步", &reason);
        return;
    }
    let source_autoincrement =
        contains_unquoted_keyword(source_metadata.create_sql, "AUTOINCREMENT");
    let target_autoincrement =
        contains_unquoted_keyword(target_metadata.create_sql, "AUTOINCREMENT");
    if source_autoincrement != target_autoincrement {
        plan.block(
            &source.name,
            &format!("无法修改表 {} 的 AUTOINCREMENT 声明", source.name),
            "SQLite 首期不重建表修改已有字段的 AUTOINCREMENT 原生声明",
        );
        return;
    }
    let differences = compare_table_columns(source, target);
    let max_target_position = target
        .columns
        .iter()
        .map(|(_, column)| column.ordinal_position)
        .max()
        .unwrap_or_default();
    let mut add_columns = Vec::new();
    let mut add_risk = DatabaseSyncRisk::Normal;
    let mut drop_columns = Vec::new();

    for difference in differences {
        match difference.status {
            SchemaDiffStatus::SourceOnly => {
                let Some(column) = difference.source.as_ref() else {
                    unreachable!("源端独有字段必须包含源端定义");
                };
                if column.ordinal_position <= max_target_position {
                    plan.block(
                        &source.name,
                        &format!("无法新增字段 {}.{}", source.name, difference.name),
                        "SQLite 只能安全追加字段到目标端现有字段末尾",
                    );
                    continue;
                }
                if column.primary_key {
                    plan.block(
                        &source.name,
                        &format!("无法新增字段 {}.{}", source.name, difference.name),
                        "SQLite 不能通过 ADD COLUMN 安全新增主键字段",
                    );
                    continue;
                }
                let hidden = match column_hidden(source_metadata, &source.name, &difference.name) {
                    Ok(hidden) => hidden,
                    Err(reason) => {
                        plan.block(
                            &source.name,
                            &format!("无法新增字段 {}.{}", source.name, difference.name),
                            &reason,
                        );
                        continue;
                    }
                };
                if hidden != 0 || !column.extra.trim().is_empty() {
                    plan.block(
                        &source.name,
                        &format!("无法新增字段 {}.{}", source.name, difference.name),
                        "SQLite generated/auto_increment 字段不能通过 ADD COLUMN 无损新增",
                    );
                    continue;
                }
                let default_value =
                    match normalize_default_for_builder(column.default_value.as_deref()) {
                        Ok(default_value) => default_value,
                        Err(reason) => {
                            plan.block(
                                &source.name,
                                &format!("无法新增字段 {}.{}", source.name, difference.name),
                                &reason,
                            );
                            continue;
                        }
                    };
                if !column.nullable
                    && matches!(
                        default_value.kind,
                        SqliteDefaultKind::None | SqliteDefaultKind::Null
                    )
                {
                    plan.block(
                        &source.name,
                        &format!("无法新增字段 {}.{}", source.name, difference.name),
                        "SQLite ADD COLUMN 新增非空字段时需要非 NULL 常量默认值",
                    );
                    continue;
                }
                if default_value.kind == SqliteDefaultKind::CurrentTime {
                    plan.block(
                        &source.name,
                        &format!("无法新增字段 {}.{}", source.name, difference.name),
                        "SQLite ADD COLUMN 不支持 CURRENT_TIME/DATE/TIMESTAMP 默认值",
                    );
                    continue;
                }
                let request = AddColumnRequest {
                    name: difference.name.clone(),
                    column_type: column.column_type.clone(),
                    nullable: column.nullable,
                    default_value: default_value.value,
                    extra: String::new(),
                    comment: String::new(),
                    after_column: None,
                };
                match build_add_column_sql(context.target_database, &source.name, &request) {
                    Ok(sql) => {
                        if add_column_risk(column, source_metadata.columns.get(&difference.name))
                            == DatabaseSyncRisk::High
                        {
                            add_risk = DatabaseSyncRisk::High;
                        }
                        add_columns.push((column.ordinal_position, difference.name, sql));
                    }
                    Err(reason) => plan.block(
                        &source.name,
                        &format!("无法新增字段 {}.{}", source.name, difference.name),
                        &reason,
                    ),
                }
            }
            SchemaDiffStatus::Changed => plan.block(
                &source.name,
                &format!("无法修改字段 {}.{}", source.name, difference.name),
                "SQLite 首期不重建表修改已有字段",
            ),
            SchemaDiffStatus::TargetOnly => {
                if context.include_drops {
                    drop_columns.push(difference.name);
                } else {
                    plan.skip(
                        &source.name,
                        &format!("跳过删除目标端独有字段 {}.{}", source.name, difference.name),
                        "未开启包含删除操作",
                    );
                }
            }
        }
    }
    if !plan.blockers.is_empty() {
        return;
    }

    add_columns.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let add_count = add_columns.len();
    let add_sql = add_columns
        .into_iter()
        .map(|(_, _, sql)| sql)
        .collect::<Vec<_>>();
    if !add_sql.is_empty() {
        plan.operation(
            OperationPhase::AddColumn,
            &source.name,
            DatabaseSyncOperationKind::AddColumn,
            add_risk,
            &format!("新增表 {} 的 {} 个字段", source.name, add_count),
            add_sql,
        );
    }

    drop_columns.sort();
    for column_name in drop_columns {
        plan.operation(
            OperationPhase::DropColumn,
            &source.name,
            DatabaseSyncOperationKind::DropColumn,
            DatabaseSyncRisk::Destructive,
            &format!("删除目标端独有字段 {}.{}", source.name, column_name),
            vec![format!(
                "ALTER TABLE {}.{} DROP COLUMN {}",
                sqlite_id(context.target_database),
                sqlite_id(&source.name),
                sqlite_id(&column_name)
            )],
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SqliteDefaultKind {
    None,
    Null,
    Constant,
    CurrentTime,
}

struct NormalizedSqliteDefault {
    value: Option<String>,
    kind: SqliteDefaultKind,
}

fn normalize_default_for_builder(
    default_value: Option<&str>,
) -> Result<NormalizedSqliteDefault, String> {
    let Some(default_value) = default_value else {
        return Ok(NormalizedSqliteDefault {
            value: None,
            kind: SqliteDefaultKind::None,
        });
    };
    let default_value = default_value.trim();
    if default_value.is_empty() {
        return Err("SQLite 默认表达式为空，无法无损表达".to_string());
    }

    if let Some(literal) = parse_single_quoted_literal(default_value)? {
        if literal.trim() != literal
            || literal.is_empty()
            || builder_treats_as_raw_default(&literal)
            || contains_rejected_default_text(&literal)
        {
            return Err(format!(
                "SQLite 文本默认值 `{default_value}` 无法由当前 builder 无损表达"
            ));
        }
        return Ok(NormalizedSqliteDefault {
            value: Some(literal),
            kind: SqliteDefaultKind::Constant,
        });
    }

    let upper = default_value.to_ascii_uppercase();
    let kind = if upper == "NULL" {
        SqliteDefaultKind::Null
    } else if matches!(upper.as_str(), "TRUE" | "FALSE") || is_sqlite_numeric_literal(default_value)
    {
        SqliteDefaultKind::Constant
    } else if matches!(
        upper.as_str(),
        "CURRENT_TIME" | "CURRENT_DATE" | "CURRENT_TIMESTAMP"
    ) {
        SqliteDefaultKind::CurrentTime
    } else {
        return Err(format!(
            "SQLite 默认表达式 `{default_value}` 无法由当前 builder 无损表达"
        ));
    };
    Ok(NormalizedSqliteDefault {
        value: Some(default_value.to_string()),
        kind,
    })
}

fn parse_single_quoted_literal(value: &str) -> Result<Option<String>, String> {
    if !value.starts_with('\'') && !value.ends_with('\'') {
        return Ok(None);
    }
    let Some(body) = value
        .strip_prefix('\'')
        .and_then(|value| value.strip_suffix('\''))
    else {
        return Err(format!("SQLite 文本默认值 `{value}` 引号不完整"));
    };
    let mut decoded = String::with_capacity(body.len());
    let mut chars = body.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\'' {
            if chars.next_if_eq(&'\'').is_none() {
                return Err(format!("SQLite 文本默认值 `{value}` 包含未转义单引号"));
            }
            decoded.push('\'');
        } else {
            decoded.push(character);
        }
    }
    Ok(Some(decoded))
}

fn contains_rejected_default_text(value: &str) -> bool {
    value.contains(';') || value.contains("--") || value.contains("/*") || value.contains("*/")
}

fn builder_treats_as_raw_default(value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    upper == "NULL"
        || upper == "TRUE"
        || upper == "FALSE"
        || upper.starts_with("CURRENT_TIMESTAMP")
        || upper.starts_with("CURRENT_DATE")
        || upper.starts_with("CURRENT_TIME")
        || value.parse::<f64>().is_ok()
}

fn is_sqlite_numeric_literal(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = usize::from(matches!(bytes.first(), Some(b'+') | Some(b'-')));
    let mut integer_digits = 0;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        integer_digits += 1;
        index += 1;
    }
    let mut fraction_digits = 0;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            fraction_digits += 1;
            index += 1;
        }
    }
    if integer_digits + fraction_digits == 0 {
        return false;
    }
    if matches!(bytes.get(index), Some(b'e') | Some(b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+') | Some(b'-')) {
            index += 1;
        }
        let exponent_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if exponent_start == index {
            return false;
        }
    }
    index == bytes.len()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use deadpool_sqlite::{Config as SqliteConfig, Runtime};
    use uuid::Uuid;

    use crate::db::schema_compare::TableSnapshot;
    use crate::models::types::{ColumnSnapshot, DatabaseSyncOperationKind};

    use super::*;
    use crate::db::schema_sync::{
        ColumnSyncMetadata, PlanFragments, TablePlanContext, TableSyncMetadata,
    };

    fn column(
        ordinal_position: u32,
        column_type: &str,
        nullable: bool,
        default_value: Option<&str>,
        primary_key: bool,
        extra: &str,
    ) -> ColumnSnapshot {
        ColumnSnapshot {
            ordinal_position,
            column_type: column_type.to_string(),
            nullable,
            default_value: default_value.map(str::to_string),
            primary_key,
            extra: extra.to_string(),
            comment: String::new(),
        }
    }

    fn table(name: &str, columns: Vec<(&str, ColumnSnapshot)>) -> TableSnapshot {
        TableSnapshot {
            name: name.to_string(),
            columns: columns
                .into_iter()
                .map(|(name, details)| (name.to_string(), details))
                .collect(),
        }
    }

    fn test_table(name: &str, column_type: &str, generated: bool) -> TableSnapshot {
        table(
            name,
            vec![(
                "name",
                column(
                    1,
                    column_type,
                    false,
                    None,
                    false,
                    if generated { "generated" } else { "" },
                ),
            )],
        )
    }

    fn metadata(create_sql: &str, columns: Vec<(&str, i64)>) -> TableSyncMetadata {
        TableSyncMetadata::Sqlite {
            create_sql: create_sql.to_string(),
            columns: columns
                .into_iter()
                .map(|(name, hidden)| {
                    (
                        name.to_string(),
                        ColumnSyncMetadata::Sqlite {
                            hidden,
                            primary_key_ordinal: None,
                        },
                    )
                })
                .collect(),
        }
    }

    fn metadata_with_primary_key(
        create_sql: &str,
        columns: Vec<(&str, i64, Option<u32>)>,
    ) -> TableSyncMetadata {
        TableSyncMetadata::Sqlite {
            create_sql: create_sql.to_string(),
            columns: columns
                .into_iter()
                .map(|(name, hidden, primary_key_ordinal)| {
                    (
                        name.to_string(),
                        ColumnSyncMetadata::Sqlite {
                            hidden,
                            primary_key_ordinal,
                        },
                    )
                })
                .collect(),
        }
    }

    fn all_sql(plan: &PlanFragments) -> Vec<&str> {
        plan.operations
            .iter()
            .flat_map(|operation| operation.sql.iter().map(String::as_str))
            .collect()
    }

    #[test]
    fn metadata_query_reads_sqlite_schema_once() {
        let sql = metadata_sql("ma\"in");
        assert!(sql.contains("\"ma\"\"in\".sqlite_schema"));
        assert!(sql.contains("pragma_table_list"));
        assert!(sql.contains("table_list.type = 'table'"));
        assert!(sql.contains("objects.type = 'table'"));
        assert!(sql.contains("lower(objects.name) NOT GLOB 'sqlite_*'"));
        assert!(sql.contains("pragma_table_xinfo(objects.name"));
        assert!(sql.contains("columns.pk AS primary_key_ordinal"));
        assert!(sql.contains("'ma\"in'"));
        assert!(!sql.contains(';'));
    }

    #[test]
    fn aggregates_native_metadata_by_table_in_memory() {
        let result = aggregate_metadata_rows(vec![
            MetadataRow {
                table_name: "users".to_string(),
                create_sql: "CREATE TABLE users (name TEXT, upper_name TEXT GENERATED ALWAYS AS (upper(name)))".to_string(),
                column_name: "name".to_string(),
                hidden: 0,
                primary_key_ordinal: None,
            },
            MetadataRow {
                table_name: "users".to_string(),
                create_sql: "CREATE TABLE users (name TEXT, upper_name TEXT GENERATED ALWAYS AS (upper(name)))".to_string(),
                column_name: "upper_name".to_string(),
                hidden: 2,
                primary_key_ordinal: None,
            },
        ]);

        let TableSyncMetadata::Sqlite {
            create_sql,
            columns,
        } = &result["users"]
        else {
            panic!("应聚合为 SQLite 元数据");
        };
        assert!(create_sql.contains("GENERATED ALWAYS"));
        assert!(matches!(
            columns.get("upper_name"),
            Some(ColumnSyncMetadata::Sqlite { hidden: 2, .. })
        ));
    }

    #[tokio::test]
    async fn loads_all_sqlite_native_metadata_with_one_schema_query() {
        let path = std::env::temp_dir().join(format!(
            "db-connect-schema-sync-sqlite-metadata-{}.sqlite",
            Uuid::new_v4()
        ));
        std::fs::File::create(&path).expect("create sqlite file");
        let pool = SqliteConfig::new(path.to_str().expect("utf8 path"))
            .create_pool(Runtime::Tokio1)
            .expect("create pool");
        let conn = pool.get().await.expect("get connection");
        conn.interact(|conn| {
            conn.execute_batch(
                "CREATE TABLE users (\
                   name TEXT NOT NULL DEFAULT 'anon',\
                   upper_name TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL\
                 );\
                 CREATE TABLE audit (id INTEGER);\
                 CREATE VIEW user_names AS SELECT name FROM users;",
            )
        })
        .await
        .expect("interact")
        .expect("create schema");
        drop(conn);

        let result = load_metadata(&pool, "main").await.expect("load metadata");
        assert_eq!(
            result.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["audit", "users"]
        );
        let TableSyncMetadata::Sqlite {
            create_sql,
            columns,
        } = &result["users"]
        else {
            panic!("应加载 SQLite 元数据");
        };
        assert!(create_sql.contains("GENERATED ALWAYS"));
        assert!(matches!(
            columns.get("upper_name"),
            Some(ColumnSyncMetadata::Sqlite { hidden: 2, .. })
        ));

        pool.close();
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn excludes_virtual_tables_and_their_shadow_tables_from_metadata() {
        let path = std::env::temp_dir().join(format!(
            "db-connect-schema-sync-sqlite-physical-tables-{}.sqlite",
            Uuid::new_v4()
        ));
        std::fs::File::create(&path).expect("create sqlite file");
        let pool = SqliteConfig::new(path.to_str().expect("utf8 path"))
            .create_pool(Runtime::Tokio1)
            .expect("create pool");
        let conn = pool.get().await.expect("get connection");
        conn.interact(|conn| {
            conn.execute_batch(
                "CREATE TABLE users (id INTEGER);\
                 CREATE VIRTUAL TABLE search_documents USING fts5(body);",
            )
        })
        .await
        .expect("interact")
        .expect("create schema");
        drop(conn);

        let result = load_metadata(&pool, "main").await.expect("load metadata");
        assert_eq!(
            result.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["users"]
        );

        pool.close();
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn real_autoincrement_table_is_blocked_by_native_declaration() {
        let path = std::env::temp_dir().join(format!(
            "db-connect-schema-sync-sqlite-autoincrement-{}.sqlite",
            Uuid::new_v4()
        ));
        std::fs::File::create(&path).expect("create sqlite file");
        let pool = SqliteConfig::new(path.to_str().expect("utf8 path"))
            .create_pool(Runtime::Tokio1)
            .expect("create pool");
        let conn = pool.get().await.expect("get connection");
        conn.interact(|conn| {
            conn.execute_batch(
                "CREATE TABLE users (\
                   id INTEGER PRIMARY KEY AUTOINCREMENT,\
                   name TEXT\
                 );",
            )
        })
        .await
        .expect("interact")
        .expect("create schema");
        drop(conn);

        let tables = crate::db::schema_compare::sqlite::load_snapshot(&pool, "main")
            .await
            .expect("load snapshot");
        let native = load_metadata(&pool, "main").await.expect("load metadata");
        let source = tables
            .iter()
            .find(|table| table.name == "users")
            .expect("users table");
        let plan = plan_table(TablePlanContext {
            target_database: "main",
            source: Some(source),
            target: None,
            source_metadata: native.get("users"),
            target_metadata: None,
            include_drops: false,
        });
        assert!(plan.operations.is_empty());
        assert!(plan
            .blockers
            .iter()
            .any(|blocker| blocker.reason.contains("AUTOINCREMENT")));

        pool.close();
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn changed_table_blocks_native_autoincrement_mismatch_before_add_and_drop_columns() {
        let source_path = std::env::temp_dir().join(format!(
            "db-connect-schema-sync-sqlite-source-autoincrement-{}.sqlite",
            Uuid::new_v4()
        ));
        let target_path = std::env::temp_dir().join(format!(
            "db-connect-schema-sync-sqlite-target-autoincrement-{}.sqlite",
            Uuid::new_v4()
        ));
        std::fs::File::create(&source_path).expect("create source sqlite file");
        std::fs::File::create(&target_path).expect("create target sqlite file");
        let source_pool = SqliteConfig::new(source_path.to_str().expect("utf8 source path"))
            .create_pool(Runtime::Tokio1)
            .expect("create source pool");
        let target_pool = SqliteConfig::new(target_path.to_str().expect("utf8 target path"))
            .create_pool(Runtime::Tokio1)
            .expect("create target pool");
        let source_conn = source_pool.get().await.expect("get source connection");
        source_conn
            .interact(|conn| {
                conn.execute_batch(
                    "CREATE TABLE users (\
                       id INTEGER PRIMARY KEY AUTOINCREMENT,\
                       name TEXT,\
                       added TEXT\
                     );",
                )
            })
            .await
            .expect("source interact")
            .expect("create source schema");
        drop(source_conn);
        let target_conn = target_pool.get().await.expect("get target connection");
        target_conn
            .interact(|conn| {
                conn.execute_batch(
                    "CREATE TABLE users (\
                       id INTEGER PRIMARY KEY,\
                       name TEXT,\
                       legacy TEXT\
                     );",
                )
            })
            .await
            .expect("target interact")
            .expect("create target schema");
        drop(target_conn);

        let mut source_tables =
            crate::db::schema_compare::sqlite::load_snapshot(&source_pool, "main")
                .await
                .expect("load source snapshot");
        let target_tables = crate::db::schema_compare::sqlite::load_snapshot(&target_pool, "main")
            .await
            .expect("load target snapshot");
        let source_native = load_metadata(&source_pool, "main")
            .await
            .expect("load source metadata");
        let target_native = load_metadata(&target_pool, "main")
            .await
            .expect("load target metadata");
        let source = source_tables
            .iter_mut()
            .find(|table| table.name == "users")
            .expect("source users");
        let source_id = source
            .columns
            .iter_mut()
            .find(|(name, _)| name == "id")
            .expect("source id");
        assert_eq!(source_id.1.extra, "auto_increment");
        source_id.1.extra.clear();
        source
            .columns
            .iter_mut()
            .find(|(name, _)| name == "added")
            .expect("source added")
            .1
            .ordinal_position = 4;
        let target = target_tables
            .iter()
            .find(|table| table.name == "users")
            .expect("target users");

        let plan = plan_table(TablePlanContext {
            target_database: "main",
            source: Some(source),
            target: Some(target),
            source_metadata: source_native.get("users"),
            target_metadata: target_native.get("users"),
            include_drops: true,
        });
        assert!(plan.operations.is_empty());
        assert!(plan
            .blockers
            .iter()
            .any(|blocker| blocker.reason.contains("AUTOINCREMENT")));

        source_pool.close();
        target_pool.close();
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn creates_plain_table_from_structured_snapshot_without_copying_excluded_objects() {
        let source = table(
            "us\"ers",
            vec![
                ("id", column(1, "INTEGER", false, None, true, "")),
                (
                    "display_name",
                    column(2, "TEXT", true, Some("'anon'"), false, ""),
                ),
            ],
        );
        let native = metadata_with_primary_key(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, display_name TEXT DEFAULT 'anon', FOREIGN KEY (id) REFERENCES tenants(id))",
            vec![("id", 0, Some(1)), ("display_name", 0, None)],
        );

        let plan = plan_table(TablePlanContext {
            target_database: "ma\"in",
            source: Some(&source),
            target: None,
            source_metadata: Some(&native),
            target_metadata: None,
            include_drops: false,
        });

        assert!(plan.blockers.is_empty());
        assert_eq!(plan.operations.len(), 1);
        assert_eq!(
            plan.operations[0].kind,
            DatabaseSyncOperationKind::CreateTable
        );
        assert_eq!(plan.operations[0].sql.len(), 1);
        let sql = &plan.operations[0].sql[0];
        assert!(sql.contains("CREATE TABLE \"ma\"\"in\".\"us\"\"ers\""));
        assert!(sql.contains("DEFAULT 'anon'"));
        assert!(!sql.contains("DEFAULT '''anon'''"));
        assert!(!sql.contains("FOREIGN KEY"));
    }

    #[test]
    fn creates_composite_primary_key_in_native_sqlite_ordinal_order() {
        let source = table(
            "memberships",
            vec![
                ("a", column(1, "INTEGER", false, None, true, "")),
                ("b", column(2, "INTEGER", false, None, true, "")),
            ],
        );
        let native = metadata_with_primary_key(
            "CREATE TABLE memberships (a INTEGER, b INTEGER, PRIMARY KEY (b, a))",
            vec![("a", 0, Some(2)), ("b", 0, Some(1))],
        );

        let plan = plan_table(TablePlanContext {
            target_database: "main",
            source: Some(&source),
            target: None,
            source_metadata: Some(&native),
            target_metadata: None,
            include_drops: false,
        });

        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        assert_eq!(plan.operations.len(), 1);
        assert!(plan.operations[0].sql[0].contains("PRIMARY KEY (\"b\", \"a\")"));
    }

    #[test]
    fn missing_duplicate_or_inconsistent_sqlite_primary_key_ordinals_block_creation() {
        let source = table(
            "memberships",
            vec![
                ("a", column(1, "INTEGER", false, None, true, "")),
                ("b", column(2, "INTEGER", false, None, true, "")),
                ("note", column(3, "TEXT", true, None, false, "")),
            ],
        );
        let cases = [
            vec![("a", 0, Some(1)), ("b", 0, None), ("note", 0, None)],
            vec![("a", 0, Some(1)), ("b", 0, Some(1)), ("note", 0, None)],
            vec![("a", 0, Some(1)), ("b", 0, Some(2)), ("note", 0, Some(3))],
        ];

        for columns in cases {
            let native = metadata_with_primary_key(
                "CREATE TABLE memberships (a INTEGER, b INTEGER, note TEXT, PRIMARY KEY (a, b))",
                columns,
            );
            let plan = plan_table(TablePlanContext {
                target_database: "main",
                source: Some(&source),
                target: None,
                source_metadata: Some(&native),
                target_metadata: None,
                include_drops: false,
            });
            assert!(plan.operations.is_empty());
            assert_eq!(plan.blockers.len(), 1);
        }
    }

    #[test]
    fn autoincrement_inside_default_literal_is_not_treated_as_native_keyword() {
        let source = table(
            "notes",
            vec![(
                "body",
                column(1, "TEXT", true, Some("'AUTOINCREMENT is text'"), false, ""),
            )],
        );
        let native = metadata(
            "CREATE TABLE notes (body TEXT DEFAULT 'AUTOINCREMENT is text')",
            vec![("body", 0)],
        );

        let plan = plan_table(TablePlanContext {
            target_database: "main",
            source: Some(&source),
            target: None,
            source_metadata: Some(&native),
            target_metadata: None,
            include_drops: false,
        });
        assert!(plan.blockers.is_empty());
        assert_eq!(plan.operations.len(), 1);
        assert!(plan.operations[0].sql[0].contains("DEFAULT 'AUTOINCREMENT is text'"));
    }

    #[test]
    fn blocks_generated_autoincrement_and_special_table_recreation() {
        let cases = [
            (
                test_table("generated_users", "TEXT", true),
                metadata(
                    "CREATE TABLE generated_users (name TEXT GENERATED ALWAYS AS ('x'))",
                    vec![("name", 2)],
                ),
            ),
            (
                table(
                    "sequence_users",
                    vec![(
                        "id",
                        column(1, "INTEGER", false, None, true, "auto_increment"),
                    )],
                ),
                metadata(
                    "CREATE TABLE sequence_users (id INTEGER PRIMARY KEY AUTOINCREMENT)",
                    vec![("id", 0)],
                ),
            ),
            (
                table(
                    "strict_users",
                    vec![("id", column(1, "INTEGER", false, None, true, ""))],
                ),
                metadata(
                    "CREATE TABLE strict_users (id INTEGER PRIMARY KEY) STRICT",
                    vec![("id", 0)],
                ),
            ),
        ];

        for (source, native) in cases {
            let plan = plan_table(TablePlanContext {
                target_database: "main",
                source: Some(&source),
                target: None,
                source_metadata: Some(&native),
                target_metadata: None,
                include_drops: false,
            });
            assert!(plan.operations.is_empty());
            assert_eq!(plan.blockers.len(), 1);
        }
    }

    #[test]
    fn blocks_defaults_that_builder_cannot_recreate_losslessly() {
        for default_value in ["lower('x')", "'42'", "(42)", "X'CAFE'"] {
            let source = table(
                "users",
                vec![(
                    "value",
                    column(1, "TEXT", true, Some(default_value), false, ""),
                )],
            );
            let native = metadata("CREATE TABLE users (value TEXT)", vec![("value", 0)]);
            let plan = plan_table(TablePlanContext {
                target_database: "main",
                source: Some(&source),
                target: None,
                source_metadata: Some(&native),
                target_metadata: None,
                include_drops: false,
            });
            assert!(plan.operations.is_empty(), "default={default_value}");
            assert_eq!(plan.blockers.len(), 1, "default={default_value}");
        }
    }

    #[test]
    fn appends_plain_column_with_qualified_escaped_identifiers() {
        let source = table(
            "us\"ers",
            vec![
                ("id", column(1, "INTEGER", false, None, false, "")),
                ("na\"me", column(2, "TEXT", true, Some("'anon'"), false, "")),
            ],
        );
        let target = table(
            "us\"ers",
            vec![("id", column(1, "INTEGER", false, None, false, ""))],
        );
        let source_native = metadata(
            "CREATE TABLE users (id INTEGER, name TEXT)",
            vec![("id", 0), ("na\"me", 0)],
        );
        let target_native = metadata("CREATE TABLE users (id INTEGER)", vec![("id", 0)]);

        let plan = plan_table(TablePlanContext {
            target_database: "ma\"in",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_native),
            target_metadata: Some(&target_native),
            include_drops: false,
        });

        assert!(plan.blockers.is_empty());
        assert_eq!(plan.operations.len(), 1);
        assert_eq!(
            plan.operations[0].kind,
            DatabaseSyncOperationKind::AddColumn
        );
        assert_eq!(
            plan.operations[0].sql,
            vec!["ALTER TABLE \"ma\"\"in\".\"us\"\"ers\" ADD COLUMN \"na\"\"me\" TEXT DEFAULT 'anon'"]
        );
    }

    #[test]
    fn non_null_sqlite_add_column_with_constant_default_is_high_risk() {
        let source = table(
            "users",
            vec![
                ("id", column(1, "INTEGER", false, None, false, "")),
                ("value", column(2, "TEXT", false, Some("'seed'"), false, "")),
            ],
        );
        let target = table(
            "users",
            vec![("id", column(1, "INTEGER", false, None, false, ""))],
        );
        let source_native = metadata(
            "CREATE TABLE users (id INTEGER, value TEXT NOT NULL DEFAULT 'seed')",
            vec![("id", 0), ("value", 0)],
        );
        let target_native = metadata("CREATE TABLE users (id INTEGER)", vec![("id", 0)]);

        let plan = plan_table(TablePlanContext {
            target_database: "main",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_native),
            target_metadata: Some(&target_native),
            include_drops: false,
        });

        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        assert_eq!(plan.operations.len(), 1);
        assert_eq!(plan.operations[0].risk, DatabaseSyncRisk::High);
    }

    #[test]
    fn unsafe_add_column_shapes_are_blocked() {
        let target = table(
            "users",
            vec![("id", column(1, "INTEGER", false, None, false, ""))],
        );
        let cases = [
            (
                table(
                    "users",
                    vec![
                        ("id", column(1, "INTEGER", false, None, false, "")),
                        ("value", column(2, "TEXT", true, None, true, "")),
                    ],
                ),
                0,
            ),
            (
                table(
                    "users",
                    vec![
                        ("id", column(1, "INTEGER", false, None, false, "")),
                        ("value", column(2, "TEXT", true, None, false, "generated")),
                    ],
                ),
                2,
            ),
            (
                table(
                    "users",
                    vec![
                        ("id", column(1, "INTEGER", false, None, false, "")),
                        ("value", column(2, "TEXT", false, None, false, "")),
                    ],
                ),
                0,
            ),
            (
                table(
                    "users",
                    vec![
                        ("id", column(1, "INTEGER", false, None, false, "")),
                        (
                            "value",
                            column(2, "TEXT", true, Some("CURRENT_TIMESTAMP"), false, ""),
                        ),
                    ],
                ),
                0,
            ),
        ];

        for (source, hidden) in cases {
            let source_native = metadata(
                "CREATE TABLE users (id INTEGER, value TEXT)",
                vec![("id", 0), ("value", hidden)],
            );
            let target_native = metadata("CREATE TABLE users (id INTEGER)", vec![("id", 0)]);
            let plan = plan_table(TablePlanContext {
                target_database: "main",
                source: Some(&source),
                target: Some(&target),
                source_metadata: Some(&source_native),
                target_metadata: Some(&target_native),
                include_drops: false,
            });
            assert!(plan.operations.is_empty());
            assert!(!plan.blockers.is_empty());
        }
    }

    #[test]
    fn inserting_column_before_existing_tail_is_blocked() {
        let source = table(
            "users",
            vec![
                ("id", column(1, "INTEGER", false, None, false, "")),
                ("middle", column(2, "TEXT", true, None, false, "")),
                ("tail", column(3, "TEXT", true, None, false, "")),
            ],
        );
        let target = table(
            "users",
            vec![
                ("id", column(1, "INTEGER", false, None, false, "")),
                ("tail", column(3, "TEXT", true, None, false, "")),
            ],
        );
        let source_native = metadata(
            "CREATE TABLE users (id INTEGER, middle TEXT, tail TEXT)",
            vec![("id", 0), ("middle", 0), ("tail", 0)],
        );
        let target_native = metadata(
            "CREATE TABLE users (id INTEGER, tail TEXT)",
            vec![("id", 0), ("tail", 0)],
        );

        let plan = plan_table(TablePlanContext {
            target_database: "main",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_native),
            target_metadata: Some(&target_native),
            include_drops: false,
        });
        assert!(plan.operations.is_empty());
        assert!(plan.blockers[0].reason.contains("末尾"));
    }

    #[test]
    fn modifying_existing_column_is_blocked_instead_of_rebuilding() {
        let source = test_table("users", "text", false);
        let target = test_table("users", "integer", false);
        let native = TableSyncMetadata::Sqlite {
            create_sql: "CREATE TABLE users (name TEXT NOT NULL)".to_string(),
            columns: BTreeMap::new(),
        };
        let plan = plan_table(TablePlanContext {
            target_database: "main",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&native),
            target_metadata: Some(&native),
            include_drops: true,
        });
        assert!(plan.operations.is_empty());
        assert!(plan.blockers[0].reason.contains("不重建表"));
    }

    #[test]
    fn drop_planning_respects_include_drops_and_escapes_identifiers() {
        let source = table(
            "us\"ers",
            vec![("id", column(1, "INTEGER", false, None, false, ""))],
        );
        let target = table(
            "us\"ers",
            vec![
                ("id", column(1, "INTEGER", false, None, false, "")),
                ("old\"value", column(2, "TEXT", true, None, false, "")),
            ],
        );
        let source_native = metadata("CREATE TABLE users (id INTEGER)", vec![("id", 0)]);
        let target_native = metadata(
            "CREATE TABLE users (id INTEGER, old_value TEXT)",
            vec![("id", 0), ("old\"value", 0)],
        );

        let protected = plan_table(TablePlanContext {
            target_database: "ma\"in",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_native),
            target_metadata: Some(&target_native),
            include_drops: false,
        });
        assert!(all_sql(&protected).iter().all(|sql| !sql.contains("DROP")));
        assert_eq!(protected.skipped_items.len(), 1);

        let allowed = plan_table(TablePlanContext {
            target_database: "ma\"in",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_native),
            target_metadata: Some(&target_native),
            include_drops: true,
        });
        assert_eq!(
            all_sql(&allowed),
            vec!["ALTER TABLE \"ma\"\"in\".\"us\"\"ers\" DROP COLUMN \"old\"\"value\""]
        );
    }

    #[test]
    fn target_only_table_drop_is_protected_by_include_drops() {
        let target = table(
            "old\"table",
            vec![("id", column(1, "INTEGER", false, None, false, ""))],
        );
        let target_native = metadata("CREATE TABLE old_table (id INTEGER)", vec![("id", 0)]);
        let protected = plan_table(TablePlanContext {
            target_database: "ma\"in",
            source: None,
            target: Some(&target),
            source_metadata: None,
            target_metadata: Some(&target_native),
            include_drops: false,
        });
        assert!(all_sql(&protected).iter().all(|sql| !sql.contains("DROP")));
        assert_eq!(protected.skipped_items.len(), 1);

        let allowed = plan_table(TablePlanContext {
            target_database: "ma\"in",
            source: None,
            target: Some(&target),
            source_metadata: None,
            target_metadata: Some(&target_native),
            include_drops: true,
        });
        assert_eq!(
            all_sql(&allowed),
            vec!["DROP TABLE \"ma\"\"in\".\"old\"\"table\""]
        );
    }

    #[test]
    fn missing_plain_table_metadata_blocks_table_and_column_drops() {
        let target_only = table(
            "search_documents",
            vec![("body", column(1, "TEXT", true, None, false, ""))],
        );
        let target_only_plan = plan_table(TablePlanContext {
            target_database: "main",
            source: None,
            target: Some(&target_only),
            source_metadata: None,
            target_metadata: None,
            include_drops: true,
        });
        assert!(target_only_plan.operations.is_empty());
        assert_eq!(target_only_plan.blockers.len(), 1);

        let source = table(
            "search_documents",
            vec![("body", column(1, "TEXT", true, None, false, ""))],
        );
        let target = table(
            "search_documents",
            vec![
                ("body", column(1, "TEXT", true, None, false, "")),
                ("rank", column(2, "REAL", true, None, false, "")),
            ],
        );
        let changed_plan = plan_table(TablePlanContext {
            target_database: "main",
            source: Some(&source),
            target: Some(&target),
            source_metadata: None,
            target_metadata: None,
            include_drops: true,
        });
        assert!(changed_plan.operations.is_empty());
        assert_eq!(changed_plan.blockers.len(), 1);
    }
}
