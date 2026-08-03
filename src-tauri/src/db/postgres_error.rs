//! PostgreSQL 错误格式化：把 SQLState 映射为中文场景化描述。

use tokio_postgres::error::SqlState;

/// PostgreSQL 错误格式化：把 SQLState 映射为中文场景化描述。
/// 非数据库错误（连接失败等）保留原始信息。
pub fn format_pg_error(action: &str, e: tokio_postgres::Error) -> String {
    if let Some(db_err) = e.as_db_error() {
        format_pg_db_error_message(action, db_err.code(), db_err.message())
    } else {
        format!("{}失败: {}", action, e)
    }
}

/// 将 SQLState + message 映射为可读错误（便于单测，无需构造真实 `tokio_postgres::Error`）。
pub(crate) fn format_pg_db_error_message(
    action: &str,
    code: &SqlState,
    detail: &str,
) -> String {
    if *code == SqlState::DUPLICATE_TABLE
        || *code == SqlState::DUPLICATE_SCHEMA
        || *code == SqlState::DUPLICATE_OBJECT
        || *code == SqlState::DUPLICATE_COLUMN
    {
        format!("{}失败: 对象已存在: {}", action, detail)
    } else if *code == SqlState::UNDEFINED_TABLE
        || *code == SqlState::UNDEFINED_SCHEMA
        || *code == SqlState::UNDEFINED_COLUMN
        || *code == SqlState::UNDEFINED_OBJECT
    {
        format!("{}失败: 对象不存在: {}", action, detail)
    } else if *code == SqlState::INSUFFICIENT_PRIVILEGE {
        format!("{}失败: 权限不足: {}", action, detail)
    } else if *code == SqlState::DEPENDENT_OBJECTS_STILL_EXIST {
        format!(
            "{}失败: 存在依赖对象（视图、外键、序列等），请先处理依赖或使用 CASCADE: {}",
            action, detail
        )
    } else if *code == SqlState::INVALID_SCHEMA_NAME || *code == SqlState::INVALID_NAME {
        format!("{}失败: 名称非法: {}", action, detail)
    } else if *code == SqlState::READ_ONLY_SQL_TRANSACTION {
        format!("{}失败: 当前连接/事务为只读: {}", action, detail)
    } else if *code == SqlState::NOT_NULL_VIOLATION {
        format!(
            "{}失败: 存在 NULL 行，无法添加 NOT NULL 约束: {}",
            action, detail
        )
    } else {
        format!("{}失败 [{}]: {}", action, code.code(), detail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_pg_db_error_includes_syntax_detail_instead_of_generic_db_error() {
        let msg = format_pg_db_error_message(
            "执行 SQL",
            &SqlState::SYNTAX_ERROR,
            "syntax error at or near \"`\"",
        );
        assert_eq!(
            msg,
            "执行 SQL失败 [42601]: syntax error at or near \"`\""
        );
        assert!(!msg.contains("db error"));
    }

    #[test]
    fn format_pg_db_error_maps_undefined_table() {
        let msg = format_pg_db_error_message(
            "执行 SQL",
            &SqlState::UNDEFINED_TABLE,
            "relation \"users\" does not exist",
        );
        assert_eq!(
            msg,
            "执行 SQL失败: 对象不存在: relation \"users\" does not exist"
        );
    }

    #[test]
    fn format_pg_error_non_db_keeps_kind_message() {
        let msg = format_pg_error(
            "执行 SQL",
            tokio_postgres::Error::__private_api_timeout(),
        );
        assert_eq!(msg, "执行 SQL失败: timeout waiting for server");
        assert!(!msg.contains("db error"));
    }
}
