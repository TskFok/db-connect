use crate::models::types::{DatabaseTableList, TableInfo};
use std::collections::{HashMap, HashSet};

/// 名称按原值去重，保留首次请求顺序；不 trim/改大小写，以免改变标识符。
pub(crate) fn normalize_databases(databases: &[String]) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for database in databases {
        if seen.insert(database) {
            if normalized.len() == 256 {
                return Err("批量目录请求去重后最多允许 256 个数据库/schema".to_string());
            }
            normalized.push(database.clone());
        }
    }
    Ok(normalized)
}

/// 只按请求名称归组，不丢掉空目录；同名表始终属于各自的目录。
pub(crate) fn group_tables(
    databases: &[String],
    rows: impl IntoIterator<Item = (String, TableInfo)>,
) -> Result<Vec<DatabaseTableList>, String> {
    let indexes: HashMap<&str, usize> = databases
        .iter()
        .enumerate()
        .map(|(index, database)| (database.as_str(), index))
        .collect();
    let mut groups: Vec<DatabaseTableList> = databases
        .iter()
        .map(|database| DatabaseTableList {
            database: database.clone(),
            tables: Vec::new(),
        })
        .collect();
    for (database, table) in rows {
        let index = indexes
            .get(database.as_str())
            .ok_or_else(|| "目录查询返回了未请求的数据库/schema".to_string())?;
        groups[*index].tables.push(table);
    }
    Ok(groups)
}
