use std::collections::{BTreeMap, BTreeSet};

use clickhouse_rs::Client;
use serde::Deserialize;

use crate::db::clickhouse::{
    clickhouse_id, clickhouse_str, clickhouse_table_ref, fetch_json_each_rows,
};
use crate::db::schema_compare::{compare_table_columns, TableSnapshot};
use crate::models::types::{
    ColumnSnapshot, DatabaseSyncOperationKind, DatabaseSyncRisk, SchemaDiffStatus,
};

use super::{
    ColumnSyncMetadata, OperationPhase, PlanFragments, TablePlanContext, TableSyncMetadata,
};

pub(crate) fn metadata_sql() -> &'static str {
    "SELECT tables.name AS table_name, tables.engine, tables.engine_full, \
            tables.create_table_query, tables.sorting_key, tables.partition_key, \
            tables.primary_key, tables.sampling_key, tables.comment, \
            columns.name AS column_name, columns.type AS column_type, \
            columns.default_kind, columns.default_expression, columns.compression_codec, \
            columns.is_in_partition_key, columns.is_in_sorting_key, \
            columns.is_in_primary_key, columns.is_in_sampling_key \
     FROM system.tables AS tables \
     JOIN system.columns AS columns \
       ON columns.database = tables.database AND columns.table = tables.name \
     WHERE tables.database = ? AND tables.is_temporary = 0 \
       AND tables.engine NOT IN \
           ('View', 'MaterializedView', 'LiveView', 'WindowView', 'Dictionary') \
     ORDER BY tables.name, columns.position, columns.name"
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
struct MetadataRow {
    table_name: String,
    engine: String,
    engine_full: String,
    create_table_query: String,
    sorting_key: String,
    partition_key: String,
    primary_key: String,
    sampling_key: String,
    comment: String,
    column_name: String,
    #[allow(dead_code, reason = "用于与原始建表定义交叉校验的保留字段")]
    column_type: String,
    default_kind: String,
    default_expression: String,
    compression_codec: String,
    is_in_partition_key: u8,
    is_in_sorting_key: u8,
    is_in_primary_key: u8,
    is_in_sampling_key: u8,
}

#[derive(Debug)]
struct TableMetadataRows {
    engine: String,
    engine_full: String,
    create_table_query: String,
    sorting_key: String,
    partition_key: String,
    primary_key: String,
    sampling_key: String,
    comment: String,
    columns: Vec<MetadataRow>,
}

fn aggregate_metadata_rows(
    rows: Vec<MetadataRow>,
) -> Result<BTreeMap<String, TableSyncMetadata>, String> {
    let mut grouped: BTreeMap<String, TableMetadataRows> = BTreeMap::new();
    for row in rows {
        let table_name = row.table_name.clone();
        let entry = grouped
            .entry(table_name.clone())
            .or_insert_with(|| TableMetadataRows {
                engine: row.engine.clone(),
                engine_full: row.engine_full.clone(),
                create_table_query: row.create_table_query.clone(),
                sorting_key: row.sorting_key.clone(),
                partition_key: row.partition_key.clone(),
                primary_key: row.primary_key.clone(),
                sampling_key: row.sampling_key.clone(),
                comment: row.comment.clone(),
                columns: Vec::new(),
            });
        if entry.engine != row.engine
            || entry.engine_full != row.engine_full
            || entry.create_table_query != row.create_table_query
            || entry.sorting_key != row.sorting_key
            || entry.partition_key != row.partition_key
            || entry.primary_key != row.primary_key
            || entry.sampling_key != row.sampling_key
            || entry.comment != row.comment
        {
            return Err(format!("ClickHouse 表 {table_name} 的批量元数据行不一致"));
        }
        entry.columns.push(row);
    }

    grouped
        .into_iter()
        .map(|(table_name, table)| {
            let parsed = parse_create_native_definitions(&table.create_table_query)?;
            let table_ttl = engine_clause(&table.engine_full, "TTL", &["SETTINGS"])?;
            let settings = engine_clause(&table.engine_full, "SETTINGS", &[])?;
            let mut columns = BTreeMap::new();
            for row in table.columns {
                if columns
                    .insert(
                        row.column_name.clone(),
                        ColumnSyncMetadata::ClickHouse {
                            default_kind: row.default_kind,
                            default_expression: row.default_expression,
                            compression_codec: row.compression_codec,
                            ttl_expression: parsed
                                .column_ttl_expressions
                                .get(&row.column_name)
                                .cloned()
                                .unwrap_or_default(),
                            unsupported_clauses: parsed
                                .column_unsupported_clauses
                                .get(&row.column_name)
                                .cloned()
                                .unwrap_or_default(),
                            is_in_partition_key: row.is_in_partition_key != 0,
                            is_in_sorting_key: row.is_in_sorting_key != 0,
                            is_in_primary_key: row.is_in_primary_key != 0,
                            is_in_sampling_key: row.is_in_sampling_key != 0,
                        },
                    )
                    .is_some()
                {
                    return Err(format!(
                        "ClickHouse 表 {table_name} 包含重复字段元数据 {}",
                        row.column_name
                    ));
                }
            }
            Ok((
                table_name,
                TableSyncMetadata::ClickHouse {
                    engine: table.engine,
                    engine_full: table.engine_full,
                    create_table_query: table.create_table_query,
                    sorting_key: table.sorting_key,
                    partition_key: table.partition_key,
                    primary_key: table.primary_key,
                    sampling_key: table.sampling_key,
                    table_ttl,
                    settings,
                    unsupported_definitions: parsed.unsupported_definitions,
                    comment: table.comment,
                    columns,
                },
            ))
        })
        .collect()
}

#[allow(dead_code, reason = "将在后续统一同步元数据分发中调用")]
pub(crate) async fn load_metadata(
    client: &Client,
    database: &str,
) -> Result<BTreeMap<String, TableSyncMetadata>, String> {
    let rows: Vec<MetadataRow> = fetch_json_each_rows(
        client.query(metadata_sql()).bind(database),
        "查询 ClickHouse 同步表元数据失败",
    )
    .await?;
    aggregate_metadata_rows(rows)
}

fn engine_clause(engine_full: &str, keyword: &str, stops: &[&str]) -> Result<String, String> {
    let words = top_level_words(engine_full)?;
    let Some((_, keyword_end)) = words
        .iter()
        .find(|(word, _, _)| word == keyword)
        .map(|(_, start, end)| (*start, *end))
    else {
        return Ok(String::new());
    };
    let end = words
        .iter()
        .find(|(word, start, _)| *start >= keyword_end && stops.iter().any(|stop| word == stop))
        .map_or(engine_full.len(), |(_, start, _)| *start);
    let clause = engine_full[keyword_end..end].trim();
    Ok(clause.to_string())
}

fn top_level_words(value: &str) -> Result<Vec<(String, usize, usize)>, String> {
    let bytes = value.as_bytes();
    let mut words = Vec::new();
    let mut depth = 0_u32;
    let mut quote = None;
    let mut index = 0;
    while index < bytes.len() {
        if let Some(delimiter) = quote {
            if bytes[index] == b'\\' {
                index = (index + 2).min(bytes.len());
                continue;
            }
            if bytes[index] == delimiter {
                if bytes.get(index + 1) == Some(&delimiter) {
                    index += 2;
                    continue;
                }
                quote = None;
            }
            index += 1;
            continue;
        }
        match bytes[index] {
            b'\'' | b'`' | b'"' => {
                quote = Some(bytes[index]);
                index += 1;
            }
            b'(' | b'[' | b'{' => {
                depth += 1;
                index += 1;
            }
            b')' | b']' | b'}' => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| "ClickHouse 原生表达式括号不匹配".to_string())?;
                index += 1;
            }
            byte if depth == 0 && (byte.is_ascii_alphabetic() || byte == b'_') => {
                let start = index;
                index += 1;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
                {
                    index += 1;
                }
                words.push((value[start..index].to_string(), start, index));
            }
            _ => index += 1,
        }
    }
    if quote.is_some() || depth != 0 {
        return Err("ClickHouse 原生表达式引号或括号不匹配".to_string());
    }
    Ok(words)
}

#[derive(Debug, Default)]
struct ParsedCreateNativeDefinitions {
    column_ttl_expressions: BTreeMap<String, String>,
    column_unsupported_clauses: BTreeMap<String, Vec<String>>,
    unsupported_definitions: Vec<String>,
}

fn parse_create_native_definitions(
    create_table_query: &str,
) -> Result<ParsedCreateNativeDefinitions, String> {
    if create_table_query.trim().is_empty() {
        return Ok(ParsedCreateNativeDefinitions::default());
    }
    let (open, close) = create_column_list_range(create_table_query)?;
    let definitions = split_top_level(&create_table_query[open + 1..close], ',')?;
    let mut parsed = ParsedCreateNativeDefinitions::default();
    for definition in definitions {
        if let Some(keyword) = unsupported_definition_keyword(definition) {
            parsed.unsupported_definitions.push(keyword);
            continue;
        }
        let Some((name, definition_end)) = parse_leading_identifier(definition)? else {
            continue;
        };
        let remainder = definition[definition_end..].trim();
        let words = top_level_words(remainder)?;
        let unsupported_clauses = words
            .iter()
            .map(|(word, _, _)| word.as_str())
            .filter(|word| matches!(*word, "EPHEMERAL" | "SETTINGS" | "STATISTICS"))
            .map(str::to_string)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        if !unsupported_clauses.is_empty() {
            parsed
                .column_unsupported_clauses
                .insert(name.clone(), unsupported_clauses);
        }
        let ttl = engine_clause(
            remainder,
            "TTL",
            &[
                "DEFAULT",
                "MATERIALIZED",
                "ALIAS",
                "COMMENT",
                "CODEC",
                "STATISTICS",
            ],
        )?;
        if !ttl.is_empty() {
            parsed.column_ttl_expressions.insert(name, ttl);
        }
    }
    parsed.unsupported_definitions.sort();
    parsed.unsupported_definitions.dedup();
    Ok(parsed)
}

#[cfg(test)]
fn column_ttl_expressions(create_table_query: &str) -> Result<BTreeMap<String, String>, String> {
    Ok(parse_create_native_definitions(create_table_query)?.column_ttl_expressions)
}

fn unsupported_definition_keyword(definition: &str) -> Option<String> {
    let first = definition
        .trim_start()
        .split(|character: char| character.is_whitespace() || character == '(')
        .next()?;
    ["INDEX", "PROJECTION", "CONSTRAINT", "PRIMARY"]
        .iter()
        .find(|keyword| first.eq_ignore_ascii_case(keyword))
        .map(|keyword| (*keyword).to_string())
}

fn create_column_list_range(value: &str) -> Result<(usize, usize), String> {
    let bytes = value.as_bytes();
    let mut quote = None;
    let mut open = None;
    let mut depth = 0_u32;
    let mut index = 0;
    while index < bytes.len() {
        if let Some(delimiter) = quote {
            if bytes[index] == b'\\' {
                index = (index + 2).min(bytes.len());
                continue;
            }
            if bytes[index] == delimiter {
                if bytes.get(index + 1) == Some(&delimiter) {
                    index += 2;
                    continue;
                }
                quote = None;
            }
            index += 1;
            continue;
        }
        match bytes[index] {
            b'\'' | b'`' | b'"' => quote = Some(bytes[index]),
            b'(' => {
                if open.is_none() {
                    open = Some(index);
                }
                depth += 1;
            }
            b')' => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| "ClickHouse CREATE TABLE 括号不匹配".to_string())?;
                if depth == 0 {
                    return Ok((
                        open.ok_or_else(|| "ClickHouse CREATE TABLE 缺少字段列表".to_string())?,
                        index,
                    ));
                }
            }
            _ => {}
        }
        index += 1;
    }
    Err("ClickHouse CREATE TABLE 缺少完整字段列表".to_string())
}

fn split_top_level(value: &str, separator: char) -> Result<Vec<&str>, String> {
    let bytes = value.as_bytes();
    let separator = separator as u8;
    let mut parts = Vec::new();
    let mut depth = 0_u32;
    let mut quote = None;
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        if let Some(delimiter) = quote {
            if bytes[index] == b'\\' {
                index = (index + 2).min(bytes.len());
                continue;
            }
            if bytes[index] == delimiter {
                if bytes.get(index + 1) == Some(&delimiter) {
                    index += 2;
                    continue;
                }
                quote = None;
            }
            index += 1;
            continue;
        }
        match bytes[index] {
            b'\'' | b'`' | b'"' => quote = Some(bytes[index]),
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| "ClickHouse 字段定义括号不匹配".to_string())?;
            }
            byte if byte == separator && depth == 0 => {
                parts.push(value[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    if quote.is_some() || depth != 0 {
        return Err("ClickHouse 字段定义引号或括号不匹配".to_string());
    }
    parts.push(value[start..].trim());
    Ok(parts)
}

fn parse_leading_identifier(value: &str) -> Result<Option<(String, usize)>, String> {
    let trimmed = value.trim_start();
    let offset = value.len() - trimmed.len();
    let Some(first) = trimmed.as_bytes().first().copied() else {
        return Ok(None);
    };
    if matches!(first, b'`' | b'"') {
        let mut parsed = String::new();
        let mut index = 1;
        let bytes = trimmed.as_bytes();
        while index < bytes.len() {
            if bytes[index] == b'\\' {
                let escaped = trimmed
                    .get(index + 1..)
                    .and_then(|rest| rest.chars().next())
                    .ok_or_else(|| "ClickHouse 字段标识符转义不完整".to_string())?;
                match escaped {
                    'a' => parsed.push('\u{0007}'),
                    'b' => parsed.push('\u{0008}'),
                    'e' => parsed.push('\u{001b}'),
                    'f' => parsed.push('\u{000c}'),
                    'n' => parsed.push('\n'),
                    'r' => parsed.push('\r'),
                    't' => parsed.push('\t'),
                    'v' => parsed.push('\u{000b}'),
                    '0' => parsed.push('\0'),
                    'N' => {}
                    '\\' | '\'' | '"' | '`' | '/' | '=' => parsed.push(escaped),
                    _ => {
                        parsed.push('\\');
                        parsed.push(escaped);
                    }
                }
                index += 1 + escaped.len_utf8();
                continue;
            }
            if bytes[index] == first {
                if bytes.get(index + 1) == Some(&first) {
                    parsed.push(first as char);
                    index += 2;
                    continue;
                }
                return Ok(Some((parsed, offset + index + 1)));
            }
            let character = trimmed[index..]
                .chars()
                .next()
                .ok_or_else(|| "ClickHouse 字段标识符不是有效 UTF-8".to_string())?;
            parsed.push(character);
            index += character.len_utf8();
        }
        return Err("ClickHouse 字段标识符引号不完整".to_string());
    }
    let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    let name = &trimmed[..end];
    if ["INDEX", "CONSTRAINT", "PROJECTION", "PRIMARY"]
        .iter()
        .any(|keyword| name.eq_ignore_ascii_case(keyword))
    {
        return Ok(None);
    }
    Ok(Some((name.to_string(), offset + end)))
}

#[derive(Clone, Copy)]
struct TableMetadataRef<'a> {
    engine: &'a str,
    engine_full: &'a str,
    sorting_key: &'a str,
    partition_key: &'a str,
    primary_key: &'a str,
    sampling_key: &'a str,
    table_ttl: &'a str,
    settings: &'a str,
    unsupported_definitions: &'a [String],
    comment: &'a str,
    columns: &'a BTreeMap<String, ColumnSyncMetadata>,
}

fn table_metadata<'a>(
    metadata: Option<&'a TableSyncMetadata>,
    table_name: &str,
) -> Result<TableMetadataRef<'a>, String> {
    let Some(TableSyncMetadata::ClickHouse {
        engine,
        engine_full,
        sorting_key,
        partition_key,
        primary_key,
        sampling_key,
        table_ttl,
        settings,
        unsupported_definitions,
        comment,
        columns,
        ..
    }) = metadata
    else {
        return Err(format!("表 {table_name} 缺少 ClickHouse 原生元数据"));
    };
    if engine.trim().is_empty() || engine_full.trim().is_empty() {
        return Err(format!("表 {table_name} 的 ClickHouse 引擎元数据为空"));
    }
    Ok(TableMetadataRef {
        engine,
        engine_full,
        sorting_key,
        partition_key,
        primary_key,
        sampling_key,
        table_ttl,
        settings,
        unsupported_definitions,
        comment,
        columns,
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct ColumnMetadataRef<'a> {
    default_kind: &'a str,
    default_expression: &'a str,
    compression_codec: &'a str,
    ttl_expression: &'a str,
    unsupported_clauses: &'a [String],
    is_in_partition_key: bool,
    is_in_sorting_key: bool,
    is_in_primary_key: bool,
    is_in_sampling_key: bool,
}

impl ColumnMetadataRef<'_> {
    fn is_key_member(self) -> bool {
        self.is_in_partition_key
            || self.is_in_sorting_key
            || self.is_in_primary_key
            || self.is_in_sampling_key
    }
}

fn column_metadata<'a>(
    metadata: TableMetadataRef<'a>,
    table_name: &str,
    column_name: &str,
) -> Result<ColumnMetadataRef<'a>, String> {
    let Some(ColumnSyncMetadata::ClickHouse {
        default_kind,
        default_expression,
        compression_codec,
        ttl_expression,
        unsupported_clauses,
        is_in_partition_key,
        is_in_sorting_key,
        is_in_primary_key,
        is_in_sampling_key,
    }) = metadata.columns.get(column_name)
    else {
        return Err(format!(
            "字段 {table_name}.{column_name} 缺少 ClickHouse 原生元数据"
        ));
    };
    Ok(ColumnMetadataRef {
        default_kind,
        default_expression,
        compression_codec,
        ttl_expression,
        unsupported_clauses,
        is_in_partition_key: *is_in_partition_key,
        is_in_sorting_key: *is_in_sorting_key,
        is_in_primary_key: *is_in_primary_key,
        is_in_sampling_key: *is_in_sampling_key,
    })
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
    if let Err(reason) = validate_supported_native_definitions(metadata, &source.name) {
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
        let native = match column_metadata(metadata, &source.name, name) {
            Ok(native) => native,
            Err(reason) => {
                plan.block(
                    &source.name,
                    &format!("无法创建字段 {}.{}", source.name, name),
                    &reason,
                );
                continue;
            }
        };
        match column_definition(column, native, &source.name, name) {
            Ok(definition) => {
                definitions.push(format!("  {} {}", clickhouse_id(name), definition));
            }
            Err(reason) => plan.block(
                &source.name,
                &format!("无法创建字段 {}.{}", source.name, name),
                &reason,
            ),
        }
    }
    if !plan.blockers.is_empty() {
        return;
    }
    let mut engine_full = metadata.engine_full.trim().trim_end_matches(';').trim();
    if let Some(without_engine) = engine_full.strip_prefix("ENGINE =") {
        engine_full = without_engine.trim();
    }
    let comment = if metadata.comment.is_empty() {
        String::new()
    } else {
        format!(" COMMENT {}", clickhouse_str(metadata.comment))
    };
    plan.operation(
        OperationPhase::CreateTable,
        &source.name,
        DatabaseSyncOperationKind::CreateTable,
        DatabaseSyncRisk::Normal,
        &format!("创建目标端表 {}", source.name),
        vec![format!(
            "CREATE TABLE {} (\n{}\n) ENGINE = {}{}",
            clickhouse_table_ref(context.target_database, &source.name),
            definitions.join(",\n"),
            engine_full,
            comment
        )],
    );
}

fn plan_target_only_table(
    plan: &mut PlanFragments,
    context: &TablePlanContext<'_>,
    target: &TableSnapshot,
) {
    if let Err(reason) = table_metadata(context.target_metadata, &target.name) {
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
                "DROP TABLE {}",
                clickhouse_table_ref(context.target_database, &target.name)
            )],
        );
    } else {
        plan.skip(&target.name, "跳过删除目标端独有表", "未开启包含删除操作");
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
            plan.block(&source.name, "无法规划 ClickHouse 表同步", &reason);
            return;
        }
    };
    let target_metadata = match table_metadata(context.target_metadata, &target.name) {
        Ok(metadata) => metadata,
        Err(reason) => {
            plan.block(&source.name, "无法规划 ClickHouse 表同步", &reason);
            return;
        }
    };
    for (metadata, table_name) in [
        (source_metadata, source.name.as_str()),
        (target_metadata, target.name.as_str()),
    ] {
        if let Err(reason) = validate_supported_native_definitions(metadata, table_name) {
            plan.block(&source.name, "无法规划 ClickHouse 表同步", &reason);
        }
    }
    if !plan.blockers.is_empty() {
        return;
    }
    if primary_key_members(source) != primary_key_members(target)
        || source_metadata.primary_key != target_metadata.primary_key
        || source_metadata.sorting_key != target_metadata.sorting_key
    {
        plan.block(
            &source.name,
            &format!("无法修改表 {} 的主键或排序键", source.name),
            "ClickHouse 首期不修改主键或排序键表达式",
        );
        return;
    }
    if source_metadata.engine != target_metadata.engine
        || source_metadata.engine_full != target_metadata.engine_full
        || source_metadata.partition_key != target_metadata.partition_key
        || source_metadata.sampling_key != target_metadata.sampling_key
        || source_metadata.table_ttl != target_metadata.table_ttl
        || source_metadata.settings != target_metadata.settings
    {
        plan.block(
            &source.name,
            &format!("无法修改表 {} 的原生表定义", source.name),
            "ClickHouse 首期不修改引擎、分区键、排序键、主键、采样键、TTL 或表 settings",
        );
        return;
    }

    let differences = compare_table_columns(source, target);
    let mut add_columns = Vec::new();
    let mut alter_columns = Vec::new();
    let mut comment_columns = Vec::new();
    let mut drop_columns = Vec::new();
    let mut handled = BTreeSet::new();
    for difference in differences {
        handled.insert(difference.name.clone());
        match difference.status {
            SchemaDiffStatus::SourceOnly => {
                let column = difference
                    .source
                    .as_ref()
                    .expect("源端独有字段必须包含源端定义");
                let native = match column_metadata(source_metadata, &source.name, &difference.name)
                {
                    Ok(native) => native,
                    Err(reason) => {
                        plan.block(
                            &source.name,
                            &format!("无法新增字段 {}.{}", source.name, difference.name),
                            &reason,
                        );
                        continue;
                    }
                };
                match column_definition(column, native, &source.name, &difference.name) {
                    Ok(definition) => add_columns.push((
                        column.ordinal_position,
                        difference.name.clone(),
                        add_column_sql(
                            context.target_database,
                            &source.name,
                            &difference.name,
                            &format!(
                                "{}{}",
                                definition,
                                source_position_clause(source, &difference.name)
                            ),
                        ),
                    )),
                    Err(reason) => plan.block(
                        &source.name,
                        &format!("无法新增字段 {}.{}", source.name, difference.name),
                        &reason,
                    ),
                }
            }
            SchemaDiffStatus::TargetOnly => {
                let column = difference
                    .target
                    .as_ref()
                    .expect("目标端独有字段必须包含目标端定义");
                if context.include_drops {
                    drop_columns.push((
                        column.ordinal_position,
                        difference.name.clone(),
                        drop_column_sql(context.target_database, &target.name, &difference.name),
                    ));
                } else {
                    plan.skip(
                        &source.name,
                        &format!("跳过删除字段 {}.{}", source.name, difference.name),
                        "未开启包含删除操作",
                    );
                }
            }
            SchemaDiffStatus::Changed => {
                let source_column = difference
                    .source
                    .as_ref()
                    .expect("变化字段必须包含源端定义");
                let source_native =
                    match column_metadata(source_metadata, &source.name, &difference.name) {
                        Ok(native) => native,
                        Err(reason) => {
                            plan.block(
                                &source.name,
                                &format!("无法修改字段 {}.{}", source.name, difference.name),
                                &reason,
                            );
                            continue;
                        }
                    };
                let target_native =
                    match column_metadata(target_metadata, &target.name, &difference.name) {
                        Ok(native) => native,
                        Err(reason) => {
                            plan.block(
                                &source.name,
                                &format!("无法修改字段 {}.{}", source.name, difference.name),
                                &reason,
                            );
                            continue;
                        }
                    };
                plan_modified_column(
                    plan,
                    context,
                    source,
                    &difference.name,
                    source_column,
                    source_native,
                    target_native,
                    &difference.changed_fields,
                    &mut alter_columns,
                    &mut comment_columns,
                );
            }
        }
    }

    for (name, source_column) in &source.columns {
        if handled.contains(name) {
            continue;
        }
        let Some((_, _target_column)) = target
            .columns
            .iter()
            .find(|(target_name, _)| target_name == name)
        else {
            continue;
        };
        let source_native = match column_metadata(source_metadata, &source.name, name) {
            Ok(native) => native,
            Err(reason) => {
                plan.block(
                    &source.name,
                    &format!("无法比较字段 {}.{}", source.name, name),
                    &reason,
                );
                continue;
            }
        };
        let target_native = match column_metadata(target_metadata, &target.name, name) {
            Ok(native) => native,
            Err(reason) => {
                plan.block(
                    &source.name,
                    &format!("无法比较字段 {}.{}", source.name, name),
                    &reason,
                );
                continue;
            }
        };
        if source_native != target_native {
            plan_modified_column(
                plan,
                context,
                source,
                name,
                source_column,
                source_native,
                target_native,
                &[],
                &mut alter_columns,
                &mut comment_columns,
            );
        }
    }

    push_column_operation(
        plan,
        OperationPhase::AddColumn,
        &source.name,
        DatabaseSyncOperationKind::AddColumn,
        DatabaseSyncRisk::Normal,
        "新增字段",
        &mut add_columns,
    );
    push_column_operation(
        plan,
        OperationPhase::AlterColumn,
        &source.name,
        DatabaseSyncOperationKind::AlterColumn,
        DatabaseSyncRisk::High,
        "修改字段",
        &mut alter_columns,
    );
    push_column_operation(
        plan,
        OperationPhase::DropColumn,
        &source.name,
        DatabaseSyncOperationKind::DropColumn,
        DatabaseSyncRisk::Destructive,
        "删除字段",
        &mut drop_columns,
    );
    push_column_operation(
        plan,
        OperationPhase::AlterColumn,
        &source.name,
        DatabaseSyncOperationKind::UpdateComment,
        DatabaseSyncRisk::Normal,
        "更新字段注释",
        &mut comment_columns,
    );
    if source_metadata.comment != target_metadata.comment {
        plan.operation(
            OperationPhase::AlterColumn,
            &source.name,
            DatabaseSyncOperationKind::UpdateComment,
            DatabaseSyncRisk::Normal,
            &format!("更新表 {} 的注释", source.name),
            vec![format!(
                "ALTER TABLE {} MODIFY COMMENT {}",
                clickhouse_table_ref(context.target_database, &source.name),
                clickhouse_str(source_metadata.comment)
            )],
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn plan_modified_column(
    plan: &mut PlanFragments,
    context: &TablePlanContext<'_>,
    source: &TableSnapshot,
    name: &str,
    source_column: &ColumnSnapshot,
    source_native: ColumnMetadataRef<'_>,
    target_native: ColumnMetadataRef<'_>,
    changed_fields: &[String],
    alter_columns: &mut Vec<(u32, String, String)>,
    comment_columns: &mut Vec<(u32, String, String)>,
) {
    if key_membership(source_native) != key_membership(target_native) {
        plan.block(
            &source.name,
            &format!("无法修改字段 {}.{} 的键成员关系", source.name, name),
            "ClickHouse 首期不修改主键或排序键表达式",
        );
        return;
    }
    let key_member = source_native.is_key_member() || target_native.is_key_member();
    let key_type_changed = changed_fields
        .iter()
        .any(|field| matches!(field.as_str(), "column_type" | "nullable"));
    if key_member && key_type_changed {
        plan.block(
            &source.name,
            &format!("无法修改键成员字段 {}.{} 的类型", source.name, name),
            "ClickHouse 首期不修改分区键、排序键、主键或采样键成员字段类型",
        );
        return;
    }
    let comment_changed = changed_fields.iter().any(|field| field == "comment");
    if comment_changed {
        comment_columns.push((
            source_column.ordinal_position,
            name.to_string(),
            comment_column_sql(
                context.target_database,
                &source.name,
                name,
                &source_column.comment,
            ),
        ));
    }
    if changed_fields.iter().all(|field| field == "comment") && source_native == target_native {
        return;
    }
    let mut action_order = 0_u8;
    if source_native.default_kind.trim().is_empty() && !target_native.default_kind.trim().is_empty()
    {
        let property = match normalized_default_kind(target_native.default_kind, &source.name, name)
        {
            Ok(property) => property,
            Err(reason) => {
                plan.block(
                    &source.name,
                    &format!("无法修改字段 {}.{}", source.name, name),
                    &reason,
                );
                return;
            }
        };
        alter_columns.push((
            source_column.ordinal_position,
            ordered_column_action(name, action_order),
            remove_column_property_sql(context.target_database, &source.name, name, property),
        ));
        action_order += 1;
    }
    if source_native.compression_codec.trim().is_empty()
        && !target_native.compression_codec.trim().is_empty()
    {
        alter_columns.push((
            source_column.ordinal_position,
            ordered_column_action(name, action_order),
            remove_column_property_sql(context.target_database, &source.name, name, "CODEC"),
        ));
        action_order += 1;
    }
    if source_native.ttl_expression.trim().is_empty()
        && !target_native.ttl_expression.trim().is_empty()
    {
        alter_columns.push((
            source_column.ordinal_position,
            ordered_column_action(name, action_order),
            remove_column_property_sql(context.target_database, &source.name, name, "TTL"),
        ));
        action_order += 1;
    }
    let definition_changed = changed_fields
        .iter()
        .any(|field| field != "comment" && field != "primary_key")
        || native_definition(source_native) != native_definition(target_native);
    if !definition_changed {
        return;
    }
    match column_definition_for_modify(source_column, source_native, &source.name, name) {
        Ok(definition) => alter_columns.push((
            source_column.ordinal_position,
            ordered_column_action(name, action_order),
            modify_column_sql(
                context.target_database,
                &source.name,
                name,
                &format!("{}{}", definition, source_position_clause(source, name)),
            ),
        )),
        Err(reason) => plan.block(
            &source.name,
            &format!("无法修改字段 {}.{}", source.name, name),
            &reason,
        ),
    }
}

fn key_membership(metadata: ColumnMetadataRef<'_>) -> (bool, bool, bool, bool) {
    (
        metadata.is_in_partition_key,
        metadata.is_in_sorting_key,
        metadata.is_in_primary_key,
        metadata.is_in_sampling_key,
    )
}

fn native_definition(metadata: ColumnMetadataRef<'_>) -> (&str, &str, &str, &str) {
    (
        metadata.default_kind,
        metadata.default_expression,
        metadata.compression_codec,
        metadata.ttl_expression,
    )
}

fn ordered_column_action(name: &str, order: u8) -> String {
    format!("{name}\0{order:02}")
}

fn push_column_operation(
    plan: &mut PlanFragments,
    phase: OperationPhase,
    table_name: &str,
    kind: DatabaseSyncOperationKind,
    risk: DatabaseSyncRisk,
    verb: &str,
    statements: &mut Vec<(u32, String, String)>,
) {
    if statements.is_empty() {
        return;
    }
    statements.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    plan.operation(
        phase,
        table_name,
        kind,
        risk,
        &format!("为目标端表 {table_name}{verb}"),
        statements
            .drain(..)
            .map(|(_, _, statement)| statement)
            .collect(),
    );
}

fn primary_key_members(table: &TableSnapshot) -> BTreeSet<&str> {
    table
        .columns
        .iter()
        .filter(|(_, column)| column.primary_key)
        .map(|(name, _)| name.as_str())
        .collect()
}

fn validate_supported_native_definitions(
    metadata: TableMetadataRef<'_>,
    table_name: &str,
) -> Result<(), String> {
    if !metadata.unsupported_definitions.is_empty() {
        return Err(format!(
            "表 {table_name} 包含首期不支持且无法无损重建的原生定义: {}",
            metadata.unsupported_definitions.join(", ")
        ));
    }
    for (column_name, metadata) in metadata.columns {
        let ColumnSyncMetadata::ClickHouse {
            unsupported_clauses,
            ..
        } = metadata
        else {
            return Err(format!(
                "字段 {table_name}.{column_name} 的同步元数据不是 ClickHouse 变体"
            ));
        };
        let mut unsupported = unsupported_clauses.clone();
        unsupported.sort();
        unsupported.dedup();
        if !unsupported.is_empty() {
            return Err(format!(
                "字段 {table_name}.{column_name} 包含首期不支持且无法无损重建的原生子句: {}",
                unsupported.join(", ")
            ));
        }
    }
    Ok(())
}

fn column_definition(
    column: &ColumnSnapshot,
    metadata: ColumnMetadataRef<'_>,
    table_name: &str,
    column_name: &str,
) -> Result<String, String> {
    build_column_definition(column, metadata, table_name, column_name, true)
}

fn column_definition_for_modify(
    column: &ColumnSnapshot,
    metadata: ColumnMetadataRef<'_>,
    table_name: &str,
    column_name: &str,
) -> Result<String, String> {
    build_column_definition(column, metadata, table_name, column_name, false)
}

fn build_column_definition(
    column: &ColumnSnapshot,
    metadata: ColumnMetadataRef<'_>,
    table_name: &str,
    column_name: &str,
    include_comment: bool,
) -> Result<String, String> {
    if column.column_type.trim().is_empty() {
        return Err(format!("字段 {table_name}.{column_name} 的类型为空"));
    }
    let mut unsupported = metadata.unsupported_clauses.to_vec();
    unsupported.sort();
    unsupported.dedup();
    if !unsupported.is_empty() {
        return Err(format!(
            "字段 {table_name}.{column_name} 包含首期不支持且无法无损重建的原生子句: {}",
            unsupported.join(", ")
        ));
    }
    let expression = metadata.default_expression.trim();
    let normalized_kind = normalized_default_kind(metadata.default_kind, table_name, column_name)?;
    if normalized_kind.is_empty() != expression.is_empty() {
        return Err(format!(
            "字段 {table_name}.{column_name} 的 default_kind 与 default_expression 不一致"
        ));
    }
    let extra = column.extra.trim();
    if !extra.is_empty() && !extra.eq_ignore_ascii_case(normalized_kind) {
        return Err(format!(
            "字段 {table_name}.{column_name} 的 extra 无法由 ClickHouse 原生默认子句无损表达"
        ));
    }
    if normalized_kind.is_empty() {
        if column.default_value.is_some() {
            return Err(format!(
                "字段 {table_name}.{column_name} 缺少结构化 default_kind"
            ));
        }
    } else if column.default_value.as_deref() != Some(metadata.default_expression) {
        return Err(format!(
            "字段 {table_name}.{column_name} 的默认表达式快照与原生元数据不一致"
        ));
    }
    let codec = metadata.compression_codec.trim();
    if !(codec.is_empty()
        || (codec
            .get(..6)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("CODEC("))
            && codec.ends_with(')')))
    {
        return Err(format!(
            "字段 {table_name}.{column_name} 的 codec 无法无损重建: {codec}"
        ));
    }
    let mut definition = column.column_type.trim().to_string();
    if !normalized_kind.is_empty() {
        definition.push_str(&format!(" {normalized_kind} {expression}"));
    }
    if include_comment && !column.comment.is_empty() {
        definition.push_str(&format!(" COMMENT {}", clickhouse_str(&column.comment)));
    }
    if !codec.is_empty() {
        definition.push(' ');
        definition.push_str(codec);
    }
    if !metadata.ttl_expression.trim().is_empty() {
        definition.push_str(" TTL ");
        definition.push_str(metadata.ttl_expression.trim());
    }
    Ok(definition)
}

fn normalized_default_kind<'a>(
    kind: &'a str,
    table_name: &str,
    column_name: &str,
) -> Result<&'a str, String> {
    let kind = kind.trim();
    match kind {
        "" => Ok(""),
        _ if kind.eq_ignore_ascii_case("DEFAULT") => Ok("DEFAULT"),
        _ if kind.eq_ignore_ascii_case("MATERIALIZED") => Ok("MATERIALIZED"),
        _ if kind.eq_ignore_ascii_case("ALIAS") => Ok("ALIAS"),
        _ => Err(format!(
            "字段 {table_name}.{column_name} 包含未知 default_kind {kind}"
        )),
    }
}

fn source_position_clause(source: &TableSnapshot, column_name: &str) -> String {
    let mut columns = source.columns.iter().collect::<Vec<_>>();
    columns.sort_by(|left, right| {
        left.1
            .ordinal_position
            .cmp(&right.1.ordinal_position)
            .then_with(|| left.0.cmp(&right.0))
    });
    let Some(index) = columns.iter().position(|(name, _)| name == column_name) else {
        return String::new();
    };
    if index == 0 {
        " FIRST".to_string()
    } else {
        format!(" AFTER {}", clickhouse_id(&columns[index - 1].0))
    }
}

fn add_column_sql(database: &str, table: &str, name: &str, definition: &str) -> String {
    format!(
        "ALTER TABLE {} ADD COLUMN {} {}",
        clickhouse_table_ref(database, table),
        clickhouse_id(name),
        definition
    )
}

fn modify_column_sql(database: &str, table: &str, name: &str, definition: &str) -> String {
    format!(
        "ALTER TABLE {} MODIFY COLUMN {} {}",
        clickhouse_table_ref(database, table),
        clickhouse_id(name),
        definition
    )
}

fn remove_column_property_sql(database: &str, table: &str, name: &str, property: &str) -> String {
    format!(
        "ALTER TABLE {} MODIFY COLUMN {} REMOVE {}",
        clickhouse_table_ref(database, table),
        clickhouse_id(name),
        property
    )
}

fn comment_column_sql(database: &str, table: &str, name: &str, comment: &str) -> String {
    format!(
        "ALTER TABLE {} COMMENT COLUMN {} {}",
        clickhouse_table_ref(database, table),
        clickhouse_id(name),
        clickhouse_str(comment)
    )
}

fn drop_column_sql(database: &str, table: &str, name: &str) -> String {
    format!(
        "ALTER TABLE {} DROP COLUMN {}",
        clickhouse_table_ref(database, table),
        clickhouse_id(name)
    )
}

#[cfg(test)]
mod tests {
    use crate::db::schema_compare::TableSnapshot;
    use crate::db::schema_sync::{ColumnSyncMetadata, TablePlanContext, TableSyncMetadata};
    use crate::models::types::ColumnSnapshot;

    use super::*;

    fn column(
        ordinal_position: u32,
        column_type: &str,
        primary_key: bool,
        extra: &str,
        comment: &str,
    ) -> ColumnSnapshot {
        ColumnSnapshot {
            ordinal_position,
            column_type: column_type.to_string(),
            nullable: false,
            default_value: match extra.to_ascii_lowercase().as_str() {
                "default" | "materialized" | "alias" => Some("now()".to_string()),
                "ephemeral" => Some("42".to_string()),
                _ => None,
            },
            primary_key,
            extra: extra.to_string(),
            comment: comment.to_string(),
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

    fn test_table(name: &str, primary_key: bool, extra: &str) -> TableSnapshot {
        table(
            name,
            vec![("id", column(1, "UInt64", primary_key, extra, ""))],
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn metadata(
        engine: &str,
        engine_full: &str,
        sorting_key: &str,
        partition_key: &str,
        primary_key: &str,
        sampling_key: &str,
        table_ttl: &str,
        settings: &str,
        comment: &str,
        columns: Vec<(&str, ColumnSyncMetadata)>,
    ) -> TableSyncMetadata {
        TableSyncMetadata::ClickHouse {
            engine: engine.to_string(),
            engine_full: engine_full.to_string(),
            create_table_query: String::new(),
            sorting_key: sorting_key.to_string(),
            partition_key: partition_key.to_string(),
            primary_key: primary_key.to_string(),
            sampling_key: sampling_key.to_string(),
            table_ttl: table_ttl.to_string(),
            settings: settings.to_string(),
            unsupported_definitions: Vec::new(),
            comment: comment.to_string(),
            columns: columns
                .into_iter()
                .map(|(name, metadata)| (name.to_string(), metadata))
                .collect(),
        }
    }

    #[test]
    fn metadata_query_loads_engine_keys_and_column_native_clauses_once() {
        let sql = metadata_sql();
        assert!(sql.contains("FROM system.tables AS tables"));
        assert!(sql.contains("JOIN system.columns AS columns"));
        assert!(sql.contains("tables.engine_full"));
        assert!(sql.contains("tables.sampling_key"));
        assert!(sql.contains("tables.create_table_query"));
        assert!(sql.contains("columns.default_expression"));
        assert!(sql.contains("columns.compression_codec"));
        assert!(!sql.contains("columns.statistics"));
        assert!(sql.contains("tables.sorting_key"));
        assert!(sql.contains("tables.partition_key"));
        assert!(sql.contains("tables.primary_key"));
        assert!(sql.contains("tables.database = ?"));
        assert!(sql.contains("'MaterializedView'"));
        assert!(sql.contains("'LiveView'"));
        assert!(sql.contains("'WindowView'"));
        assert!(sql.contains("'Dictionary'"));
        assert!(!sql.contains("tables.name = ?"));
    }

    #[test]
    fn primary_key_membership_change_is_blocked() {
        let source = test_table("events", true, "");
        let target = test_table("events", false, "");
        let metadata = metadata(
            "MergeTree",
            "MergeTree ORDER BY id",
            "id",
            "",
            "id",
            "",
            "",
            "",
            "",
            vec![],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "analytics_copy",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&metadata),
            target_metadata: Some(&metadata),
            include_drops: false,
        });
        assert!(plan.operations.is_empty());
        assert_eq!(
            plan.blockers[0].reason,
            "ClickHouse 首期不修改主键或排序键表达式"
        );
    }

    #[test]
    fn native_column_definition_keeps_default_codec_ttl_and_comment() {
        let source = table(
            "event`s",
            vec![(
                "created`at",
                column(1, "DateTime", false, "default", "创建's"),
            )],
        );
        let metadata = metadata(
            "MergeTree",
            "MergeTree ORDER BY tuple()",
            "tuple()",
            "",
            "tuple()",
            "",
            "",
            "",
            "表's",
            vec![(
                "created`at",
                ColumnSyncMetadata::ClickHouse {
                    default_kind: "DEFAULT".to_string(),
                    default_expression: "now()".to_string(),
                    compression_codec: "CODEC(Delta, ZSTD(3))".to_string(),
                    ttl_expression: "created_at + INTERVAL 7 DAY".to_string(),
                    unsupported_clauses: Vec::new(),
                    is_in_partition_key: false,
                    is_in_sorting_key: false,
                    is_in_primary_key: false,
                    is_in_sampling_key: false,
                },
            )],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "analytics`copy",
            source: Some(&source),
            target: None,
            source_metadata: Some(&metadata),
            target_metadata: None,
            include_drops: false,
        });

        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        assert_eq!(plan.operations.len(), 1);
        let sql = &plan.operations[0].sql[0];
        assert!(sql.starts_with("CREATE TABLE `analytics``copy`.`event``s`"));
        assert!(sql.contains(
            "`created``at` DateTime DEFAULT now() COMMENT '创建''s' CODEC(Delta, ZSTD(3)) TTL created_at + INTERVAL 7 DAY"
        ));
        assert!(sql.contains("ENGINE = MergeTree ORDER BY tuple()"));
        assert_eq!(sql.matches("ORDER BY").count(), 1);
        assert!(sql.ends_with("COMMENT '表''s'"));
    }

    #[test]
    fn include_drops_false_never_emits_drop_sql() {
        let target = test_table("obsolete`table", false, "");
        let target_metadata = metadata("Memory", "Memory", "", "", "", "", "", "", "", vec![]);
        let plan = plan_table(TablePlanContext {
            target_database: "analytics`copy",
            source: None,
            target: Some(&target),
            source_metadata: None,
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });

        let all_sql = plan
            .operations
            .iter()
            .flat_map(|operation| operation.sql.iter())
            .collect::<Vec<_>>();
        assert!(all_sql.iter().all(|sql| !sql.contains("DROP")));
        assert_eq!(plan.skipped_items.len(), 1);
    }

    #[test]
    fn changing_engine_or_native_table_clauses_is_blocked_without_partial_sql() {
        let source = test_table("events", false, "");
        let target = source.clone();
        let source_metadata = metadata(
            "MergeTree",
            "MergeTree PARTITION BY toYYYYMM(ts) ORDER BY id SAMPLE BY cityHash64(id) TTL ts + INTERVAL 30 DAY SETTINGS index_granularity = 4096",
            "id",
            "toYYYYMM(ts)",
            "id",
            "cityHash64(id)",
            "ts + INTERVAL 30 DAY",
            "index_granularity = 4096",
            "",
            vec![],
        );
        let target_metadata = metadata(
            "MergeTree",
            "MergeTree ORDER BY id",
            "id",
            "",
            "id",
            "",
            "",
            "",
            "",
            vec![],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "analytics",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: true,
        });

        assert!(plan.operations.is_empty());
        assert_eq!(
            plan.blockers[0].reason,
            "ClickHouse 首期不修改引擎、分区键、排序键、主键、采样键、TTL 或表 settings"
        );
    }

    #[test]
    fn unknown_default_kind_and_unsafe_extra_are_blocked() {
        let source = test_table("events", false, "ephemeral");
        let source_metadata = metadata(
            "MergeTree",
            "MergeTree ORDER BY tuple()",
            "tuple()",
            "",
            "tuple()",
            "",
            "",
            "",
            "",
            vec![(
                "id",
                ColumnSyncMetadata::ClickHouse {
                    default_kind: "EPHEMERAL".to_string(),
                    default_expression: "42".to_string(),
                    compression_codec: String::new(),
                    ttl_expression: String::new(),
                    unsupported_clauses: Vec::new(),
                    is_in_partition_key: false,
                    is_in_sorting_key: false,
                    is_in_primary_key: false,
                    is_in_sampling_key: false,
                },
            )],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "analytics",
            source: Some(&source),
            target: None,
            source_metadata: Some(&source_metadata),
            target_metadata: None,
            include_drops: false,
        });

        assert!(plan.operations.is_empty());
        assert!(plan.blockers.iter().any(|blocker| {
            blocker.reason.contains("未知 default_kind EPHEMERAL")
                || blocker.reason.contains("extra")
        }));
    }

    #[test]
    fn adds_and_reorders_columns_with_stable_first_after_clauses() {
        let source = table(
            "events",
            vec![
                ("created_at", column(1, "DateTime", false, "default", "")),
                ("id", column(2, "UInt64", false, "", "")),
                ("payload", column(3, "String", false, "", "")),
            ],
        );
        let target = table("events", vec![("id", column(1, "UInt32", false, "", ""))]);
        let column_metadata = |kind: &str| ColumnSyncMetadata::ClickHouse {
            default_kind: kind.to_string(),
            default_expression: if kind.is_empty() {
                String::new()
            } else {
                "now()".to_string()
            },
            compression_codec: String::new(),
            ttl_expression: String::new(),
            unsupported_clauses: Vec::new(),
            is_in_partition_key: false,
            is_in_sorting_key: false,
            is_in_primary_key: false,
            is_in_sampling_key: false,
        };
        let source_metadata = metadata(
            "MergeTree",
            "MergeTree ORDER BY tuple()",
            "tuple()",
            "",
            "tuple()",
            "",
            "",
            "",
            "",
            vec![
                ("created_at", column_metadata("DEFAULT")),
                ("id", column_metadata("")),
                ("payload", column_metadata("")),
            ],
        );
        let target_metadata = metadata(
            "MergeTree",
            "MergeTree ORDER BY tuple()",
            "tuple()",
            "",
            "tuple()",
            "",
            "",
            "",
            "",
            vec![("id", column_metadata(""))],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "analytics",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });

        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        let sql = plan
            .operations
            .iter()
            .flat_map(|operation| operation.sql.iter())
            .collect::<Vec<_>>();
        assert!(sql.iter().any(|sql| sql.ends_with("FIRST")));
        assert!(sql.iter().any(|sql| sql.ends_with("AFTER `id`")));
        assert!(sql.iter().any(|sql| {
            sql.contains("MODIFY COLUMN `id` UInt64") && sql.ends_with("AFTER `created_at`")
        }));
    }

    #[test]
    fn aggregates_table_and_column_native_clauses_in_memory() {
        let metadata = aggregate_metadata_rows(vec![MetadataRow {
            table_name: "event`s".to_string(),
            engine: "MergeTree".to_string(),
            engine_full: "MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (id, ts) SAMPLE BY cityHash64(id) TTL ts + INTERVAL 30 DAY SETTINGS index_granularity = 4096".to_string(),
            create_table_query: "CREATE TABLE source.`event``s` (`id` UInt64 CODEC(Delta, ZSTD(3)), `expire``at` DateTime64(3, 'UTC') DEFAULT now64(3) TTL expire_at + INTERVAL 7 DAY) ENGINE = MergeTree ORDER BY (id, expire_at)".to_string(),
            sorting_key: "id, ts".to_string(),
            partition_key: "toYYYYMM(ts)".to_string(),
            primary_key: "id, ts".to_string(),
            sampling_key: "cityHash64(id)".to_string(),
            comment: "事件".to_string(),
            column_name: "expire`at".to_string(),
            column_type: "DateTime64(3, 'UTC')".to_string(),
            default_kind: "DEFAULT".to_string(),
            default_expression: "now64(3)".to_string(),
            compression_codec: "CODEC(Delta, ZSTD(3))".to_string(),
            is_in_partition_key: 1,
            is_in_sorting_key: 1,
            is_in_primary_key: 0,
            is_in_sampling_key: 0,
        }])
        .expect("批量元数据应可纯内存聚合");

        let TableSyncMetadata::ClickHouse {
            table_ttl,
            settings,
            sampling_key,
            columns,
            ..
        } = &metadata["event`s"]
        else {
            panic!("应聚合为 ClickHouse 元数据");
        };
        assert_eq!(table_ttl, "ts + INTERVAL 30 DAY");
        assert_eq!(settings, "index_granularity = 4096");
        assert_eq!(sampling_key, "cityHash64(id)");
        assert!(matches!(
            columns.get("expire`at"),
            Some(ColumnSyncMetadata::ClickHouse {
                default_kind,
                compression_codec,
                ttl_expression,
                is_in_partition_key: true,
                is_in_sorting_key: true,
                ..
            }) if default_kind == "DEFAULT"
                && compression_codec == "CODEC(Delta, ZSTD(3))"
                && ttl_expression == "expire_at + INTERVAL 7 DAY"
        ));
    }

    #[test]
    fn malformed_unicode_codec_is_blocked_instead_of_panicking() {
        let source = test_table("events", false, "");
        let native = ColumnMetadataRef {
            default_kind: "",
            default_expression: "",
            compression_codec: "a压缩abc",
            ttl_expression: "",
            unsupported_clauses: &[],
            is_in_partition_key: false,
            is_in_sorting_key: false,
            is_in_primary_key: false,
            is_in_sampling_key: false,
        };

        let result = column_definition(&source.columns[0].1, native, "events", "id");
        assert!(result
            .expect_err("非法 codec 应返回阻塞原因")
            .contains("codec 无法无损重建"));
    }

    #[test]
    fn quoted_identifier_parser_handles_backslash_before_unicode_without_panicking() {
        let ttl = column_ttl_expressions(
            "CREATE TABLE source.events (`a\\中` UInt64 TTL id + 1) ENGINE = Memory",
        )
        .expect("反斜杠后的多字节字符不应触发 UTF-8 切片 panic");

        assert_eq!(ttl.get("a\\中").map(String::as_str), Some("id + 1"));
    }

    fn metadata_row(create_table_query: &str) -> MetadataRow {
        MetadataRow {
            table_name: "events".to_string(),
            engine: "MergeTree".to_string(),
            engine_full: "MergeTree ORDER BY id".to_string(),
            create_table_query: create_table_query.to_string(),
            sorting_key: "id".to_string(),
            partition_key: String::new(),
            primary_key: "id".to_string(),
            sampling_key: String::new(),
            comment: String::new(),
            column_name: "id".to_string(),
            column_type: "UInt64".to_string(),
            default_kind: String::new(),
            default_expression: String::new(),
            compression_codec: String::new(),
            is_in_partition_key: 0,
            is_in_sorting_key: 1,
            is_in_primary_key: 1,
            is_in_sampling_key: 0,
        }
    }

    #[test]
    fn identifiers_named_ttl_or_settings_are_not_mistaken_for_native_clauses() {
        assert_eq!(
            engine_clause("MergeTree ORDER BY ttl", "TTL", &["SETTINGS"])
                .expect("排序字段 ttl 不是表 TTL 子句"),
            ""
        );
        assert_eq!(
            engine_clause("MergeTree ORDER BY settings", "SETTINGS", &[])
                .expect("排序字段 settings 不是表 settings 子句"),
            ""
        );
        assert!(column_ttl_expressions(
            "CREATE TABLE source.events (`id` UInt64 DEFAULT ttl) ENGINE = MergeTree ORDER BY id"
        )
        .expect("默认表达式字段 ttl 不是列 TTL 子句")
        .is_empty());
    }

    #[test]
    fn unsupported_native_definitions_block_instead_of_being_silently_dropped() {
        let definitions = [
            "`id` UInt64, INDEX idx id TYPE minmax GRANULARITY 1",
            "`id` UInt64, PROJECTION by_id (SELECT id ORDER BY id)",
            "`id` UInt64, CONSTRAINT positive CHECK id > 0",
            "`id` UInt64 SETTINGS min_compress_block_size = 8192",
            "`id` UInt64 STATISTICS(tdigest)",
        ];
        for definitions in definitions {
            let create_query = format!(
                "CREATE TABLE source.events ({definitions}) ENGINE = MergeTree ORDER BY id"
            );
            let metadata = aggregate_metadata_rows(vec![metadata_row(&create_query)])
                .expect("原生定义应被结构化识别为不支持，而不是令加载失败");
            let source = test_table("events", true, "");
            let plan = plan_table(TablePlanContext {
                target_database: "analytics",
                source: Some(&source),
                target: None,
                source_metadata: metadata.get("events"),
                target_metadata: None,
                include_drops: false,
            });

            assert!(plan.operations.is_empty(), "不应近似重建: {definitions}");
            assert!(
                plan.blockers.iter().any(|blocker| {
                    blocker.reason.contains("无法无损重建") || blocker.reason.contains("不支持")
                }),
                "应对不支持的原生定义返回 blocker: {definitions} / {:?}",
                plan.blockers
            );
        }
    }

    fn native_column(
        default_kind: &str,
        default_expression: &str,
        compression_codec: &str,
        ttl_expression: &str,
        is_key_member: bool,
    ) -> ColumnSyncMetadata {
        ColumnSyncMetadata::ClickHouse {
            default_kind: default_kind.to_string(),
            default_expression: default_expression.to_string(),
            compression_codec: compression_codec.to_string(),
            ttl_expression: ttl_expression.to_string(),
            unsupported_clauses: Vec::new(),
            is_in_partition_key: false,
            is_in_sorting_key: is_key_member,
            is_in_primary_key: is_key_member,
            is_in_sampling_key: false,
        }
    }

    #[test]
    fn key_column_comment_only_change_uses_comment_column_without_modify() {
        let source = table(
            "events",
            vec![("id", column(1, "UInt64", true, "", "新注释"))],
        );
        let target = table(
            "events",
            vec![("id", column(1, "UInt64", true, "", "旧注释"))],
        );
        let source_metadata = metadata(
            "MergeTree",
            "MergeTree ORDER BY id",
            "id",
            "",
            "id",
            "",
            "",
            "",
            "",
            vec![("id", native_column("", "", "", "", true))],
        );
        let target_metadata = source_metadata.clone();
        let plan = plan_table(TablePlanContext {
            target_database: "analytics",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });

        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        let sql = plan
            .operations
            .iter()
            .flat_map(|operation| operation.sql.iter().map(String::as_str))
            .collect::<Vec<_>>();
        assert_eq!(
            sql,
            vec!["ALTER TABLE `analytics`.`events` COMMENT COLUMN `id` '新注释'"]
        );
        assert!(plan
            .operations
            .iter()
            .all(|operation| operation.kind == DatabaseSyncOperationKind::UpdateComment));
    }

    #[test]
    fn removing_native_column_properties_emits_explicit_remove_and_comment_actions() {
        let source = table(
            "events",
            vec![("payload", column(1, "String", false, "", ""))],
        );
        let target = table(
            "events",
            vec![("payload", column(1, "String", false, "default", "旧注释"))],
        );
        let source_metadata = metadata(
            "MergeTree",
            "MergeTree ORDER BY tuple()",
            "tuple()",
            "",
            "tuple()",
            "",
            "",
            "",
            "",
            vec![("payload", native_column("", "", "", "", false))],
        );
        let target_metadata = metadata(
            "MergeTree",
            "MergeTree ORDER BY tuple()",
            "tuple()",
            "",
            "tuple()",
            "",
            "",
            "",
            "",
            vec![(
                "payload",
                native_column(
                    "DEFAULT",
                    "now()",
                    "CODEC(ZSTD(3))",
                    "created_at + INTERVAL 7 DAY",
                    false,
                ),
            )],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "analytics",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });

        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        let sql = plan
            .operations
            .iter()
            .flat_map(|operation| operation.sql.iter().map(String::as_str))
            .collect::<Vec<_>>();
        assert!(sql
            .iter()
            .any(|sql| sql.ends_with("MODIFY COLUMN `payload` REMOVE DEFAULT")));
        assert!(sql
            .iter()
            .any(|sql| sql.ends_with("MODIFY COLUMN `payload` REMOVE CODEC")));
        assert!(sql
            .iter()
            .any(|sql| sql.ends_with("MODIFY COLUMN `payload` REMOVE TTL")));
        assert!(sql
            .iter()
            .any(|sql| sql.ends_with("COMMENT COLUMN `payload` ''")));
    }

    #[test]
    fn final_plan_escapes_backslashes_adjacent_to_identifier_and_literal_delimiters() {
        let source = table(
            r"event\`s",
            vec![(
                r"id\`x",
                column(1, "UInt64", false, "", r"C:\new\' , DROP COLUMN secret -- "),
            )],
        );
        let target = table(
            r"event\`s",
            vec![(r"id\`x", column(1, "UInt64", false, "", "旧注释"))],
        );
        let source_metadata = metadata(
            "Memory",
            "Memory",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            vec![(r"id\`x", native_column("", "", "", "", false))],
        );
        let target_metadata = source_metadata.clone();
        let plan = plan_table(TablePlanContext {
            target_database: r"ana\`lytics",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });

        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        assert_eq!(
            plan.operations[0].sql,
            vec![
                r"ALTER TABLE `ana\\``lytics`.`event\\``s` COMMENT COLUMN `id\\``x` 'C:\\new\\'' , DROP COLUMN secret -- '"
            ]
        );
    }
}
