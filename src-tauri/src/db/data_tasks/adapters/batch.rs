use crate::{db::data_tasks::value::DataValue, models::data_tasks::DataDiffOperation};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    Sqlite,
    Postgres,
    MySql,
    SqlServer,
    ClickHouse,
}
pub struct WriteBatch {
    pub sql: String,
    pub params: Vec<DataValue>,
    pub parameter_columns: Vec<usize>,
    pub table: String,
    pub kind: DataDiffOperation,
    pub columns: Vec<String>,
}
impl Dialect {
    pub fn parameter_limit(self) -> usize {
        match self {
            Self::Sqlite => 999,
            Self::SqlServer => 2100,
            _ => 65535,
        }
    }
    pub fn identifier(self, name: &str) -> String {
        match self {
            Self::MySql | Self::ClickHouse => format!("`{}`", name.replace('`', "``")),
            Self::SqlServer => format!("[{}]", name.replace(']', "]]")),
            _ => format!("\"{}\"", name.replace('"', "\"\"")),
        }
    }
    fn placeholder(self, n: usize) -> String {
        match self {
            Self::Postgres => format!("${n}"),
            Self::SqlServer => format!("@P{n}"),
            _ => "?".into(),
        }
    }
}
pub fn parameters_per_row(columns: usize, keys: usize, kind: DataDiffOperation) -> usize {
    match kind {
        DataDiffOperation::Insert => columns,
        DataDiffOperation::Delete => keys,
        DataDiffOperation::Update => (columns - keys) * (keys + 1) + keys,
        _ => 0,
    }
}
pub fn build_batch(
    dialect: Dialect,
    schema: &str,
    table: &str,
    columns: &[String],
    key_indices: &[usize],
    kind: DataDiffOperation,
    rows: &[Vec<DataValue>],
) -> Result<WriteBatch, String> {
    if columns.is_empty()
        || rows.is_empty()
        || rows.len() > 500
        || columns
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != columns.len()
        || key_indices.iter().any(|i| *i >= columns.len())
        || key_indices
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != key_indices.len()
        || rows.iter().any(|r| r.len() != columns.len())
    {
        return Err("集合写入字段、行形状或批次大小无效".into());
    }
    if !matches!(kind, DataDiffOperation::Insert)
        && (key_indices.is_empty()
            || rows
                .iter()
                .any(|r| key_indices.iter().any(|i| r[*i].is_null())))
    {
        return Err("集合更新及删除必须具有非空主键".into());
    }
    let required = parameters_per_row(columns.len(), key_indices.len(), kind)
        .checked_mul(rows.len())
        .ok_or("参数数量溢出")?;
    if required == 0 || required > dialect.parameter_limit() {
        return Err("集合写入超过方言参数预算".into());
    }
    let target = format!(
        "{}.{}",
        dialect.identifier(schema),
        dialect.identifier(table)
    );
    let names = columns
        .iter()
        .map(|c| dialect.identifier(c))
        .collect::<Vec<_>>();
    let mut params = Vec::with_capacity(required);
    let mut parameter_columns = Vec::with_capacity(required);
    fn bind(
        dialect: Dialect,
        params: &mut Vec<DataValue>,
        parameter_columns: &mut Vec<usize>,
        column: usize,
        v: &DataValue,
    ) -> String {
        params.push(v.clone());
        parameter_columns.push(column);
        dialect.placeholder(params.len())
    }
    fn predicate(
        dialect: Dialect,
        params: &mut Vec<DataValue>,
        parameter_columns: &mut Vec<usize>,
        names: &[String],
        keys: &[usize],
        r: &[DataValue],
    ) -> String {
        keys.iter()
            .map(|i| {
                format!(
                    "{} = {}",
                    names[*i],
                    bind(dialect, params, parameter_columns, *i, &r[*i])
                )
            })
            .collect::<Vec<_>>()
            .join(" AND ")
    }
    let sql = match kind {
        DataDiffOperation::Insert => {
            let tuples = rows
                .iter()
                .map(|r| {
                    format!(
                        "({})",
                        r.iter()
                            .enumerate()
                            .map(|(index, v)| bind(
                                dialect,
                                &mut params,
                                &mut parameter_columns,
                                index,
                                v
                            ))
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("INSERT INTO {target} ({}) VALUES {tuples}", names.join(","))
        }
        DataDiffOperation::Delete => {
            let conditions = rows
                .iter()
                .map(|r| {
                    format!(
                        "({})",
                        predicate(
                            dialect,
                            &mut params,
                            &mut parameter_columns,
                            &names,
                            key_indices,
                            r
                        )
                    )
                })
                .collect::<Vec<_>>()
                .join(" OR ");
            format!("DELETE FROM {target} WHERE {conditions}")
        }
        DataDiffOperation::Update => {
            let mut assignments = Vec::new();
            for index in 0..columns.len() {
                if key_indices.contains(&index) {
                    continue;
                }
                let cases = rows
                    .iter()
                    .map(|r| {
                        format!(
                            "WHEN {} THEN {}",
                            predicate(
                                dialect,
                                &mut params,
                                &mut parameter_columns,
                                &names,
                                key_indices,
                                r
                            ),
                            bind(
                                dialect,
                                &mut params,
                                &mut parameter_columns,
                                index,
                                &r[index]
                            )
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                assignments.push(format!(
                    "{} = CASE {cases} ELSE {} END",
                    names[index], names[index]
                ));
            }
            let conditions = rows
                .iter()
                .map(|r| {
                    format!(
                        "({})",
                        predicate(
                            dialect,
                            &mut params,
                            &mut parameter_columns,
                            &names,
                            key_indices,
                            r
                        )
                    )
                })
                .collect::<Vec<_>>()
                .join(" OR ");
            format!(
                "UPDATE {target} SET {} WHERE {conditions}",
                assignments.join(",")
            )
        }
        _ => return Err("保留行不能生成 DML".into()),
    };
    Ok(WriteBatch {
        sql,
        params,
        parameter_columns,
        table: table.into(),
        kind,
        columns: columns.to_vec(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn writes_use_bound_collection_operations_for_each_dialect() {
        let columns = vec!["主键".into(), "v\"alue".into()];
        let rows = vec![
            vec![DataValue::Int(1), DataValue::Text("quote'中文".into())],
            vec![DataValue::Int(2), DataValue::Null],
        ];
        for dialect in [
            Dialect::Sqlite,
            Dialect::Postgres,
            Dialect::MySql,
            Dialect::SqlServer,
        ] {
            for kind in [
                DataDiffOperation::Insert,
                DataDiffOperation::Update,
                DataDiffOperation::Delete,
            ] {
                let batch =
                    build_batch(dialect, "main", "order", &columns, &[0], kind, &rows).unwrap();
                assert!(!batch.sql.contains("quote'中文"));
                assert!(!batch.sql.contains("SELECT"));
                assert!(!batch.params.is_empty());
                assert!(batch.sql.contains("order"));
            }
        }
    }
    #[test]
    fn unsafe_shape_and_parameter_overflow_are_rejected() {
        assert!(build_batch(
            Dialect::Sqlite,
            "main",
            "t",
            &["id".into()],
            &[],
            DataDiffOperation::Delete,
            &[vec![DataValue::Int(1)]]
        )
        .is_err());
        assert!(build_batch(
            Dialect::SqlServer,
            "dbo",
            "t",
            &vec!["c".into(); 2101],
            &[0],
            DataDiffOperation::Insert,
            &[vec![DataValue::Int(1); 2101]]
        )
        .is_err());
    }
}
