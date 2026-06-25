use crate::db::dialect::{MYSQL_DIALECT, POSTGRES_DIALECT};

/// Escape a MySQL identifier by doubling internal backticks and wrapping in backticks.
/// Prevents SQL injection through identifier names (database, table, column, index, trigger).
pub fn esc_id(name: &str) -> String {
    MYSQL_DIALECT.identifier(name)
}

/// Escape a MySQL string literal by doubling single quotes and wrapping in single quotes.
/// Also doubles backslashes so generated SQL preserves literal `\` under MySQL's default
/// backslash-escape string mode.
pub fn esc_str(value: &str) -> String {
    MYSQL_DIALECT.string_literal(value)
}

pub fn mysql_paginated_select(
    columns_sql: &str,
    schema: &str,
    table: &str,
    where_sql: &str,
    order_sql: &str,
    limit: u64,
    offset: u64,
) -> String {
    MYSQL_DIALECT.paginated_select(
        columns_sql,
        schema,
        table,
        where_sql,
        order_sql,
        limit,
        offset,
    )
}

pub fn mysql_count_query(schema: &str, table: &str, where_sql: &str) -> String {
    MYSQL_DIALECT.count_query(schema, table, where_sql)
}

pub fn mysql_sql_editor_allowed_on_read_only_connection(sql: &str) -> bool {
    MYSQL_DIALECT.sql_editor_allowed_on_read_only_connection(sql)
}

pub fn pg_id(name: &str) -> String {
    POSTGRES_DIALECT.identifier(name)
}

/// PostgreSQL 字符串字面值转义（仅双写单引号，不像 MySQL 还需处理反斜杠，
/// 因为 PostgreSQL 默认 `standard_conforming_strings = on`）。
pub fn pg_str(value: &str) -> String {
    POSTGRES_DIALECT.string_literal(value)
}

pub fn postgres_paginated_select(
    columns_sql: &str,
    schema: &str,
    table: &str,
    where_sql: &str,
    order_sql: &str,
    limit: u64,
    offset: u64,
) -> String {
    POSTGRES_DIALECT.paginated_select(
        columns_sql,
        schema,
        table,
        where_sql,
        order_sql,
        limit,
        offset,
    )
}

pub fn postgres_count_query(schema: &str, table: &str, where_sql: &str) -> String {
    POSTGRES_DIALECT.count_query(schema, table, where_sql)
}

pub fn postgres_sql_editor_allowed_on_read_only_connection(sql: &str) -> bool {
    POSTGRES_DIALECT.sql_editor_allowed_on_read_only_connection(sql)
}

/// 去掉 DDL 中 `` `schema_name`. `` 形式的库名限定，便于导入到任意目标库（由客户端先 `USE` 或导入时指定库）。
pub fn strip_export_schema_qualifiers(ddl: &str, schema: &str) -> String {
    let prefix = format!("{}.", esc_id(schema));
    ddl.replace(&prefix, "")
}

/// 校验客户端传入的 where_clause，拒绝可能导致 SQL 注入的模式（防御深度加固）。
/// 前端通过 WhereFilterBuilder 生成的子句应已安全，此校验防止绕过前端直接调用时的注入。
/// 返回 Ok(()) 表示通过，Err(msg) 表示拒绝。
pub fn validate_where_clause(clause: &str) -> Result<(), String> {
    let clause = clause.trim();
    if clause.is_empty() {
        return Ok(());
    }
    if clause.contains(';') {
        return Err("WHERE 子句包含非法字符".to_string());
    }
    if clause.contains("--") {
        return Err("WHERE 子句包含非法注释".to_string());
    }
    if clause.contains("/*") || clause.contains("*/") {
        return Err("WHERE 子句包含非法注释".to_string());
    }
    // 正规化空白：把所有空白字符（空格/制表/换行/回车等）压成单个空格，并在首尾补空格。
    // 这样 `UNION\tSELECT`、`UNION\nSELECT` 等用非空格分隔的绕过手段也能被关键字匹配到。
    let normalized = clause.split_whitespace().collect::<Vec<_>>().join(" ");
    let upper = format!(" {} ", normalized.to_uppercase());
    // 拒绝 UNION 等可能用于注入的关键字（仅在未加引号时危险，此处保守拒绝）
    for kw in [
        " UNION ",
        " UNION(",
        " INTO OUTFILE ",
        " INTO DUMPFILE ",
        " LOAD_FILE(",
        " BENCHMARK(",
        " SLEEP(",
        " EXECUTE ",
        " EXECUTE(",
        " LOAD DATA ",
    ] {
        if upper.contains(kw) {
            return Err("WHERE 子句包含非法关键字".to_string());
        }
    }
    Ok(())
}

/// 校验存储引擎名（防御深度）：仅允许字母、数字、下划线（如 InnoDB / MyISAM / MEMORY）。
/// engine 无法用 esc_id/esc_str（它是裸 SQL 片段），故用白名单拒绝注入字符。
pub fn validate_engine_name(engine: &str) -> Result<(), String> {
    let e = engine.trim();
    if e.is_empty() {
        return Err("存储引擎名不能为空".to_string());
    }
    if e.len() > 64 {
        return Err("存储引擎名过长".to_string());
    }
    if e.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        Ok(())
    } else {
        Err("存储引擎名包含非法字符".to_string())
    }
}

/// 校验列类型片段（防御深度）：如 `varchar(255)`、`int unsigned`、`decimal(10,2)`、`enum('a','b')`。
/// column_type 是裸 SQL 片段无法转义，拒绝分号、反引号、反斜杠、注释符等危险字符。
pub fn validate_column_type(column_type: &str) -> Result<(), String> {
    let t = column_type.trim();
    if t.is_empty() {
        return Err("列类型不能为空".to_string());
    }
    if t.len() > 255 {
        return Err("列类型过长".to_string());
    }
    if t.contains(';')
        || t.contains('`')
        || t.contains('\\')
        || t.contains("--")
        || t.contains("/*")
        || t.contains("*/")
    {
        return Err("列类型包含非法字符".to_string());
    }
    let ok = t.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(c, ' ' | '(' | ')' | ',' | '\'' | '.' | '_' | '-' | '+')
    });
    if ok {
        Ok(())
    } else {
        Err("列类型包含非法字符".to_string())
    }
}

/// 校验列 extra 片段（防御深度）：如 `auto_increment`、`ON UPDATE CURRENT_TIMESTAMP`。
/// 允许为空；拒绝分号、反引号、注释符等危险字符。
pub fn validate_column_extra(extra: &str) -> Result<(), String> {
    let e = extra.trim();
    if e.is_empty() {
        return Ok(());
    }
    if e.len() > 128 {
        return Err("列 extra 过长".to_string());
    }
    if e.contains(';')
        || e.contains('`')
        || e.contains('\\')
        || e.contains("--")
        || e.contains("/*")
        || e.contains("*/")
    {
        return Err("列 extra 包含非法字符".to_string());
    }
    let ok = e
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '(' | ')'));
    if ok {
        Ok(())
    } else {
        Err("列 extra 包含非法字符".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_esc_id_simple() {
        assert_eq!(esc_id("users"), "`users`");
    }

    #[test]
    fn test_esc_id_with_backtick() {
        assert_eq!(esc_id("my`table"), "`my``table`");
    }

    #[test]
    fn test_esc_id_empty() {
        assert_eq!(esc_id(""), "``");
    }

    #[test]
    fn test_esc_id_multiple_backticks() {
        assert_eq!(esc_id("a`b`c"), "`a``b``c`");
    }

    #[test]
    fn test_esc_str_simple() {
        assert_eq!(esc_str("hello"), "'hello'");
    }

    #[test]
    fn test_strip_export_schema_qualifiers() {
        let ddl = "CREATE TABLE `mydb`.`users` (`id` int)";
        assert_eq!(
            strip_export_schema_qualifiers(ddl, "mydb"),
            "CREATE TABLE `users` (`id` int)"
        );
        assert_eq!(
            strip_export_schema_qualifiers("CREATE TABLE `users` (`id` int)", "mydb"),
            "CREATE TABLE `users` (`id` int)"
        );
    }

    #[test]
    fn test_strip_export_schema_qualifiers_with_backtick_in_name() {
        let schema = "db`x";
        let ddl = format!("VIEW {}.`v` AS SELECT 1", esc_id(schema));
        let stripped = strip_export_schema_qualifiers(&ddl, schema);
        assert_eq!(stripped, "VIEW `v` AS SELECT 1");
    }

    #[test]
    fn test_esc_str_with_quote() {
        assert_eq!(esc_str("it's"), "'it''s'");
    }

    #[test]
    fn test_esc_str_empty() {
        assert_eq!(esc_str(""), "''");
    }

    #[test]
    fn test_esc_str_multiple_quotes() {
        assert_eq!(esc_str("a'b'c"), "'a''b''c'");
    }

    #[test]
    fn test_esc_id_preserves_normal_chars() {
        assert_eq!(esc_id("my_table_123"), "`my_table_123`");
    }

    #[test]
    fn test_esc_str_preserves_backslash() {
        assert_eq!(esc_str("path\\to\\file"), "'path\\\\to\\\\file'");
    }

    #[test]
    fn test_esc_str_escapes_backslash_before_double_quote() {
        assert_eq!(esc_str("value\\\"quoted"), "'value\\\\\"quoted'");
    }

    #[test]
    fn test_mysql_dialect_builds_common_sql_fragments() {
        let dialect = crate::db::dialect::MySqlDialect;
        assert_eq!(dialect.identifier("my`table"), "`my``table`");
        assert_eq!(dialect.string_literal("it's"), "'it''s'");
        assert_eq!(dialect.table_ref("app`db", "users"), "`app``db`.`users`");
        assert_eq!(
            dialect.paginated_select("*", "app", "users", "", " ORDER BY `id` DESC", 50, 100),
            "SELECT * FROM `app`.`users` ORDER BY `id` DESC LIMIT 50 OFFSET 100"
        );
        assert_eq!(
            dialect.count_query("app", "users", " WHERE `name` = 'a'"),
            "SELECT COUNT(*) as cnt FROM `app`.`users` WHERE `name` = 'a'"
        );
    }

    #[test]
    fn test_mysql_dialect_read_only_sql_rules() {
        let dialect = crate::db::dialect::MySqlDialect;
        assert!(dialect.sql_editor_allowed_on_read_only_connection("SELECT 1"));
        assert!(dialect
            .sql_editor_allowed_on_read_only_connection("WITH a AS (SELECT 1) SELECT * FROM a"));
        assert!(dialect.sql_editor_allowed_on_read_only_connection("USE app"));
        assert!(!dialect.sql_editor_allowed_on_read_only_connection("UPDATE users SET name = 'x'"));
        assert!(!dialect.sql_editor_allowed_on_read_only_connection("DROP TABLE users"));
    }

    #[test]
    fn test_validate_where_clause_empty() {
        assert!(validate_where_clause("").is_ok());
        assert!(validate_where_clause("  ").is_ok());
    }

    #[test]
    fn test_validate_where_clause_safe() {
        assert!(validate_where_clause("`name` = 'foo'").is_ok());
        assert!(validate_where_clause("`id` > 1 AND `status` = 'active'").is_ok());
        assert!(validate_where_clause("`col` IS NULL").is_ok());
        assert!(validate_where_clause("`col` LIKE '%search%'").is_ok());
    }

    #[test]
    fn test_validate_where_clause_rejects_semicolon() {
        assert!(validate_where_clause("1=1; DROP TABLE users").is_err());
    }

    #[test]
    fn test_validate_where_clause_rejects_comments() {
        assert!(validate_where_clause("1=1 -- comment").is_err());
        assert!(validate_where_clause("1=1/*comment*/").is_err());
    }

    #[test]
    fn test_validate_where_clause_rejects_union() {
        assert!(validate_where_clause("1=1 UNION SELECT 1").is_err());
    }

    #[test]
    fn test_validate_where_clause_rejects_execute() {
        assert!(validate_where_clause("`id` = 1 EXECUTE cmd").is_err());
        assert!(validate_where_clause("`id` = 1 execute cmd").is_err());
    }

    #[test]
    fn test_validate_where_clause_rejects_load_data() {
        assert!(validate_where_clause("`id` = 1 AND LOAD DATA INFILE '/tmp/x'").is_err());
        assert!(validate_where_clause("load data infile '/tmp/x'").is_err());
    }

    #[test]
    fn test_validate_where_clause_rejects_union_with_whitespace_bypass() {
        // 用制表符/换行分隔 UNION，正规化空白后仍应被拒绝
        assert!(validate_where_clause("1=1 UNION\tSELECT 1").is_err());
        assert!(validate_where_clause("1=1 UNION\nSELECT 1").is_err());
        assert!(validate_where_clause("1=1\tUNION SELECT 1").is_err());
    }

    #[test]
    fn test_validate_engine_name() {
        assert!(validate_engine_name("InnoDB").is_ok());
        assert!(validate_engine_name("MyISAM").is_ok());
        assert!(validate_engine_name("MEMORY").is_ok());
        assert!(validate_engine_name("").is_err());
        assert!(validate_engine_name("InnoDB; DROP TABLE t").is_err());
        assert!(validate_engine_name("InnoDB`").is_err());
        assert!(validate_engine_name("Inno DB").is_err());
    }

    #[test]
    fn test_validate_column_type() {
        assert!(validate_column_type("varchar(255)").is_ok());
        assert!(validate_column_type("int unsigned").is_ok());
        assert!(validate_column_type("decimal(10,2)").is_ok());
        assert!(validate_column_type("enum('a','b')").is_ok());
        assert!(validate_column_type("bigint unsigned").is_ok());
        assert!(validate_column_type("").is_err());
        assert!(validate_column_type("int; DROP TABLE t").is_err());
        assert!(validate_column_type("int`").is_err());
        assert!(validate_column_type("int -- x").is_err());
        assert!(validate_column_type("int/*x*/").is_err());
    }

    #[test]
    fn test_validate_column_extra() {
        assert!(validate_column_extra("").is_ok());
        assert!(validate_column_extra("auto_increment").is_ok());
        assert!(validate_column_extra("ON UPDATE CURRENT_TIMESTAMP").is_ok());
        assert!(validate_column_extra("auto_increment; DROP TABLE t").is_err());
        assert!(validate_column_extra("x`y").is_err());
        assert!(validate_column_extra("a, ADD COLUMN b INT").is_err());
    }
}
