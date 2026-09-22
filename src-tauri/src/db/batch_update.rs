//! 按字段集合规划集合 UPDATE；所有 SQL 块必须在同一事务中校验、执行。
use serde::Deserialize;
use serde_json::Value as JsonValue;
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Clone, Deserialize)]
pub struct RowUpdate {
    pub primary_keys: HashMap<String, JsonValue>,
    pub updates: HashMap<String, JsonValue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchDialect {
    MySql,
    Postgres,
    SqlServer,
    Sqlite,
}

#[derive(Debug)]
pub struct BatchUpdateStatement {
    pub sql: String,
    pub params: Vec<JsonValue>,
    pub validation_sql: String,
    pub validation_params: Vec<JsonValue>,
    /// 修改定位键时，所有原目标必须存在，防止跨组更新重新定位到刚移动的行。
    pub expected_matches: Option<usize>,
}

pub fn build_batch_update_statements(
    dialect: BatchDialect,
    schema: &str,
    table: &str,
    locator_columns: &[String],
    rows: &[RowUpdate],
) -> Result<Vec<BatchUpdateStatement>, String> {
    if rows.is_empty() {
        return Err("没有提供要更新的数据".into());
    }
    if locator_columns.is_empty() {
        return Err("表没有可用的主键或唯一定位键，无法安全批量更新".into());
    }
    let mut original_keys = HashSet::new();
    for row in rows {
        if row.updates.is_empty() {
            return Err("存在没有更新内容的行".into());
        }
        if locator_columns
            .iter()
            .any(|key| !row.primary_keys.contains_key(key))
        {
            return Err("存在缺少主键信息的行".into());
        }
        if !original_keys.insert(locator_identity(locator_columns, row, false)) {
            return Err("批量更新存在重复目标行".into());
        }
    }
    let mut destination_keys = HashSet::new();
    for row in rows {
        let old = locator_identity(locator_columns, row, false);
        let new = locator_identity(locator_columns, row, true);
        if (new != old && original_keys.contains(&new)) || !destination_keys.insert(new) {
            return Err("批量更新存在相互冲突的主键修改，请分次提交".into());
        }
    }
    let changes_locator = rows.iter().any(|row| {
        locator_columns
            .iter()
            .any(|key| row.updates.contains_key(key))
    });
    let mut groups: BTreeMap<Vec<String>, Vec<&RowUpdate>> = BTreeMap::new();
    for row in rows {
        let mut columns: Vec<_> = row.updates.keys().cloned().collect();
        columns.sort();
        groups.entry(columns).or_default().push(row);
    }
    let mut statements = Vec::new();
    for (columns, group) in groups {
        let mut start = 0;
        while start < group.len() {
            let mut end = start;
            let mut update_params = 0;
            let mut validation_params = 0;
            // 分块只受参数/表达式大小约束；绝不为每行单独执行 SQL。
            while end < group.len() && end - start < 128 {
                let key_params = locator_columns
                    .iter()
                    .filter(|key| !group[end].primary_keys[*key].is_null())
                    .count();
                let cost = columns.len() * (key_params + 1) + key_params;
                let validation_cost = match destination(locator_columns, group[end]) {
                    Some(destination) => {
                        let destination_params = destination
                            .primary_keys
                            .values()
                            .filter(|v| !v.is_null())
                            .count();
                        key_params * 3 + destination_params * 2
                    }
                    None => key_params * 2,
                };
                if cost > dialect.parameter_limit() || validation_cost > dialect.parameter_limit() {
                    return Err("单行更新的参数数量超过数据库限制".into());
                }
                if update_params + cost > dialect.parameter_limit()
                    || validation_params + validation_cost > dialect.parameter_limit()
                {
                    break;
                }
                update_params += cost;
                validation_params += validation_cost;
                end += 1;
            }
            let mut statement = build_statement(
                dialect,
                schema,
                table,
                locator_columns,
                &columns,
                &group[start..end],
            );
            statement.expected_matches = changes_locator.then_some(end - start);
            statements.push(statement);
            start = end;
        }
    }
    Ok(statements)
}

fn locator_identity(columns: &[String], row: &RowUpdate, updated: bool) -> Vec<String> {
    columns
        .iter()
        .map(|column| {
            let value = if updated {
                row.updates.get(column).unwrap_or(&row.primary_keys[column])
            } else {
                &row.primary_keys[column]
            };
            // 只拒绝输入层面的精确重复。SQLite 无 affinity 主键可同时存储
            // INTEGER 1 与 TEXT '1'，是否数据库等价必须交给事务内集合校验。
            value.to_string()
        })
        .collect()
}

fn destination(keys: &[String], row: &RowUpdate) -> Option<RowUpdate> {
    if !keys.iter().any(|key| {
        row.updates
            .get(key)
            .is_some_and(|value| value != &row.primary_keys[key])
    }) {
        return None;
    }
    Some(RowUpdate {
        primary_keys: keys
            .iter()
            .map(|key| {
                (
                    key.clone(),
                    row.updates
                        .get(key)
                        .unwrap_or(&row.primary_keys[key])
                        .clone(),
                )
            })
            .collect(),
        updates: HashMap::new(),
    })
}

impl BatchDialect {
    fn parameter_limit(self) -> usize {
        match self {
            Self::MySql | Self::Postgres => 65_535,
            // sp_executesql 自身也使用参数，给 2100 上限留余量。
            Self::SqlServer => 2_000,
            Self::Sqlite => 999,
        }
    }

    fn quote(self, name: &str) -> String {
        match self {
            Self::MySql => format!("`{}`", name.replace('`', "``")),
            Self::SqlServer => format!("[{}]", name.replace(']', "]]")),
            Self::Postgres | Self::Sqlite => format!("\"{}\"", name.replace('"', "\"\"")),
        }
    }

    fn bind(self, params: &mut Vec<JsonValue>, value: &JsonValue) -> String {
        params.push(value.clone());
        match self {
            Self::Postgres => format!("${}", params.len()),
            Self::SqlServer => format!("@P{}", params.len()),
            Self::MySql | Self::Sqlite => "?".into(),
        }
    }
}

fn predicate(
    dialect: BatchDialect,
    columns: &[String],
    row: &RowUpdate,
    params: &mut Vec<JsonValue>,
) -> String {
    columns
        .iter()
        .map(|column| {
            let value = &row.primary_keys[column];
            if value.is_null() {
                format!("{} IS NULL", dialect.quote(column))
            } else {
                format!(
                    "{} = {}",
                    dialect.quote(column),
                    dialect.bind(params, value)
                )
            }
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn predicates(
    dialect: BatchDialect,
    keys: &[String],
    rows: &[&RowUpdate],
    params: &mut Vec<JsonValue>,
) -> String {
    rows.iter()
        .map(|row| format!("({})", predicate(dialect, keys, row, params)))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn build_statement(
    dialect: BatchDialect,
    schema: &str,
    table: &str,
    keys: &[String],
    columns: &[String],
    rows: &[&RowUpdate],
) -> BatchUpdateStatement {
    let target = format!("{}.{}", dialect.quote(schema), dialect.quote(table));
    let mut params = Vec::new();
    let cases: Vec<_> = columns
        .iter()
        .map(|column| {
            let branches = rows
                .iter()
                .map(|row| {
                    let condition = predicate(dialect, keys, row, &mut params);
                    let value = dialect.bind(&mut params, &row.updates[column]);
                    format!("WHEN {} THEN {}", condition, value)
                })
                .collect::<Vec<_>>()
                .join(" ");
            // PG 从 ELSE 目标列推断 UNKNOWN 参数类型，支持 enum/jsonb/domain/NULL。
            // SQL Server 的参数已是 NVARCHAR，不读 ELSE，保留原来的赋值转换。
            let fallback = if dialect == BatchDialect::SqlServer {
                String::new()
            } else {
                format!(" ELSE {}", dialect.quote(column))
            };
            format!("CASE {}{} END", branches, fallback)
        })
        .collect();
    let filter = predicates(dialect, keys, rows, &mut params);
    let sql = if dialect == BatchDialect::MySql {
        // DISTINCT 强制物化，冻结完整旧主键和所有新值；SET 更新主键也不会
        // 改变后续 CASE 的定位，并避免 MySQL 合并派生表后报 1093。
        let mut projection: Vec<_> = keys
            .iter()
            .enumerate()
            .map(|(i, key)| format!("{} AS k{}", dialect.quote(key), i))
            .collect();
        projection.extend(
            cases
                .iter()
                .enumerate()
                .map(|(i, case)| format!("{} AS v{}", case, i)),
        );
        let join = keys
            .iter()
            .enumerate()
            .map(|(i, key)| format!("t.{} <=> s.k{}", dialect.quote(key), i))
            .collect::<Vec<_>>()
            .join(" AND ");
        let assignments = columns
            .iter()
            .enumerate()
            .map(|(i, column)| format!("t.{} = s.v{}", dialect.quote(column), i))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "UPDATE {} AS t JOIN (SELECT DISTINCT {} FROM {} WHERE {}) AS s ON {} SET {}",
            target,
            projection.join(", "),
            target,
            filter,
            join,
            assignments
        )
    } else {
        let assignments = columns
            .iter()
            .zip(cases)
            .map(|(column, case)| format!("{} = {}", dialect.quote(column), case))
            .collect::<Vec<_>>()
            .join(", ");
        format!("UPDATE {} SET {} WHERE {}", target, assignments, filter)
    };
    let mut validation_params = Vec::new();
    let destinations: Vec<_> = rows.iter().map(|row| destination(keys, row)).collect();
    let mut match_terms = Vec::new();
    for (row, destination) in rows.iter().zip(&destinations) {
        match_terms.push(format!(
            "CASE WHEN {} THEN 1 ELSE 0 END",
            predicate(dialect, keys, row, &mut validation_params)
        ));
        if let Some(destination) = destination {
            let new = predicate(dialect, keys, destination, &mut validation_params);
            let old = predicate(dialect, keys, row, &mut validation_params);
            // 新目标若由另一行占用，按数据库的类型/排序规则拒绝迁移。
            // 嵌套 CASE 将 old 谓词的 UNKNOWN 也视为不匹配（NULL 复合键）。
            match_terms.push(format!(
                "CASE WHEN {} THEN CASE WHEN {} THEN 0 ELSE 2 END ELSE 0 END",
                new, old
            ));
        }
    }
    let matches = match_terms.join(" + ");
    let mut validation_filter = predicates(dialect, keys, rows, &mut validation_params);
    for destination in destinations.iter().flatten() {
        validation_filter.push_str(&format!(
            " OR ({})",
            predicate(dialect, keys, destination, &mut validation_params)
        ));
    }
    let identity = target_identity(dialect, keys);
    let hint = if dialect == BatchDialect::SqlServer {
        " WITH (UPDLOCK, HOLDLOCK)"
    } else {
        ""
    };
    let lock = if matches!(dialect, BatchDialect::MySql | BatchDialect::Postgres) {
        " FOR UPDATE"
    } else {
        ""
    };
    let validation_sql = format!(
        "SELECT {} AS batch_identity, ({}) AS batch_matches FROM {}{} WHERE {}{}",
        identity, matches, target, hint, validation_filter, lock
    );
    BatchUpdateStatement {
        sql,
        params,
        validation_sql,
        validation_params,
        expected_matches: None,
    }
}

/// 用实际存储的主键编码身份；不依赖客户端对类型/排序规则的猜测。
fn target_identity(dialect: BatchDialect, keys: &[String]) -> String {
    let columns: Vec<_> = keys.iter().map(|key| dialect.quote(key)).collect();
    match dialect {
        BatchDialect::Postgres => format!("json_build_array({})::text", columns.iter().map(|c| format!("{}::text", c)).collect::<Vec<_>>().join(", ")),
        BatchDialect::MySql => format!("CAST(JSON_ARRAY({}) AS CHAR)", columns.iter().map(|c| format!("HEX(CAST({} AS BINARY))", c)).collect::<Vec<_>>().join(", ")),
        BatchDialect::Sqlite => columns.iter().map(|c| format!("typeof({0}) || ':' || CASE WHEN typeof({0}) IN ('text', 'blob') THEN hex({0}) ELSE quote({0}) END", c)).collect::<Vec<_>>().join(" || ';' || "),
        BatchDialect::SqlServer => {
            let parts = columns.iter().map(|c| format!("CASE WHEN {0} IS NULL THEN 'N;' ELSE CONCAT('V', CONVERT(varchar(max), CONVERT(varbinary(max), {0}), 2), ';') END", c)).collect::<Vec<_>>();
            // CONCAT 至少需要两个实参，附加空字符串也适用于单列定位键。
            format!("CONCAT({}, '')", parts.join(", "))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(id: JsonValue, values: &[(&str, JsonValue)]) -> RowUpdate {
        RowUpdate {
            primary_keys: HashMap::from([("id".into(), id)]),
            updates: values
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        }
    }

    #[test]
    fn batch_groups_nonadjacent_matching_fields_and_binds_values() {
        let rows = vec![
            row(json!(1), &[("name", json!("a'"))]),
            row(json!(2), &[("age", json!(20))]),
            row(json!(3), &[("name", JsonValue::Null)]),
        ];
        let statements = build_batch_update_statements(
            BatchDialect::Postgres,
            "public",
            "items",
            &["id".into()],
            &rows,
        )
        .unwrap();
        assert_eq!(statements.len(), 2);
        let names = statements
            .iter()
            .find(|s| s.params.contains(&json!("a'")))
            .unwrap();
        assert_eq!(
            names.params,
            vec![
                json!(1),
                json!("a'"),
                json!(3),
                JsonValue::Null,
                json!(1),
                json!(3)
            ]
        );
        assert!(!names.sql.contains("a'"));
        assert!(names.sql.contains("ELSE \"name\" END"));
    }

    #[test]
    fn batch_rejects_duplicates_even_across_field_groups() {
        let rows = vec![
            row(json!(1), &[("name", json!("a"))]),
            row(json!(1), &[("age", json!(20))]),
        ];
        assert!(build_batch_update_statements(
            BatchDialect::Sqlite,
            "main",
            "items",
            &["id".into()],
            &rows
        )
        .unwrap_err()
        .contains("重复"));
    }

    #[test]
    fn batch_validates_entire_input_before_producing_statements() {
        for rows in [
            vec![],
            vec![row(json!(1), &[])],
            vec![RowUpdate {
                primary_keys: HashMap::new(),
                updates: HashMap::from([("v".into(), json!(1))]),
            }],
        ] {
            assert!(build_batch_update_statements(
                BatchDialect::MySql,
                "d",
                "t",
                &["id".into()],
                &rows
            )
            .is_err());
        }
        let rows = vec![row(json!(1), &[("v", json!(1))])];
        assert!(build_batch_update_statements(
            BatchDialect::MySql,
            "d",
            "t",
            &["id".into(), "tenant".into()],
            &rows
        )
        .is_err());
    }

    #[test]
    fn batch_splits_by_parameter_budget_without_losing_rows() {
        let rows: Vec<_> = (0..1100)
            .map(|i| {
                row(
                    json!(i),
                    &[("a", json!(i)), ("b", JsonValue::Null), ("c", json!(true))],
                )
            })
            .collect();
        for (dialect, limit) in [
            (BatchDialect::MySql, 65535),
            (BatchDialect::Postgres, 65535),
            (BatchDialect::SqlServer, 2000),
            (BatchDialect::Sqlite, 999),
        ] {
            let statements =
                build_batch_update_statements(dialect, "d", "t", &["id".into()], &rows).unwrap();
            assert!(statements.len() > 1 && statements.len() < 20);
            assert!(statements
                .iter()
                .all(|s| s.params.len() <= limit && s.validation_params.len() <= limit));
            assert_eq!(
                statements.iter().map(|s| s.params.len()).sum::<usize>(),
                7700
            );
        }
    }

    #[test]
    fn batch_key_moves_budget_all_destination_validation_parameters() {
        let keys: Vec<_> = (0..8).map(|i| format!("k{i}")).collect();
        let rows: Vec<_> = (0..100)
            .map(|i| RowUpdate {
                primary_keys: keys.iter().map(|key| (key.clone(), json!(i))).collect(),
                updates: HashMap::from([("k0".into(), json!(1000 + i))]),
            })
            .collect();
        let statements =
            build_batch_update_statements(BatchDialect::Sqlite, "main", "items", &keys, &rows)
                .unwrap();
        assert_eq!(statements.len(), 5);
        assert!(statements.iter().all(|s| s.validation_params.len() <= 999));
        assert_eq!(
            statements
                .iter()
                .map(|s| s.validation_params.len())
                .sum::<usize>(),
            4000
        );
    }

    #[test]
    fn batch_composite_null_keys_are_not_bound_as_equals_null() {
        let rows = vec![RowUpdate {
            primary_keys: HashMap::from([("a".into(), JsonValue::Null), ("b".into(), json!(2))]),
            updates: HashMap::from([("v".into(), JsonValue::Null)]),
        }];
        let statements = build_batch_update_statements(
            BatchDialect::Postgres,
            "s\"",
            "t",
            &["a".into(), "b".into()],
            &rows,
        )
        .unwrap();
        assert_eq!(
            statements[0].params,
            vec![json!(2), JsonValue::Null, json!(2)]
        );
        assert!(statements[0].sql.contains("\"a\" IS NULL"));
        assert!(statements[0].sql.contains("\"s\"\"\".\"t\""));
    }

    #[test]
    fn batch_rejects_dependent_key_moves_but_allows_independent_moves() {
        let rows = vec![
            row(json!(1), &[("id", json!(2))]),
            row(json!(2), &[("id", json!(3))]),
        ];
        assert!(build_batch_update_statements(
            BatchDialect::MySql,
            "d",
            "t",
            &["id".into()],
            &rows
        )
        .is_err());
        let rows = vec![
            row(json!(1), &[("id", json!(11))]),
            row(json!(2), &[("id", json!(12))]),
        ];
        let statements =
            build_batch_update_statements(BatchDialect::MySql, "d", "t", &["id".into()], &rows)
                .unwrap();
        assert_eq!(statements.len(), 1);
        assert!(statements[0].sql.contains("JOIN (SELECT DISTINCT"));
        assert!(statements[0].sql.contains("<=>"));
    }
}
