#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MySqlDialect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PostgresDialect;

impl MySqlDialect {
    pub fn identifier(&self, name: &str) -> String {
        format!("`{}`", name.replace('`', "``"))
    }

    pub fn string_literal(&self, value: &str) -> String {
        format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
    }

    pub fn table_ref(&self, schema: &str, table: &str) -> String {
        format!("{}.{}", self.identifier(schema), self.identifier(table))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn paginated_select(
        &self,
        columns_sql: &str,
        schema: &str,
        table: &str,
        where_sql: &str,
        order_sql: &str,
        limit: u64,
        offset: u64,
    ) -> String {
        format!(
            "SELECT {} FROM {}{}{} LIMIT {} OFFSET {}",
            columns_sql,
            self.table_ref(schema, table),
            where_sql,
            order_sql,
            limit,
            offset
        )
    }

    pub fn count_query(&self, schema: &str, table: &str, where_sql: &str) -> String {
        format!(
            "SELECT COUNT(*) as cnt FROM {}{}",
            self.table_ref(schema, table),
            where_sql
        )
    }

    pub fn sql_editor_allowed_on_read_only_connection(&self, sql: &str) -> bool {
        self.sql_editor_returns_result_set(sql) || self.is_use_statement(sql)
    }

    fn is_use_statement(&self, sql: &str) -> bool {
        let trimmed = sql.trim();
        let upper = trimmed.to_uppercase();
        upper.starts_with("USE ") || upper == "USE"
    }

    fn sql_editor_returns_result_set(&self, sql: &str) -> bool {
        let upper = sql.trim().to_uppercase();
        upper.starts_with("SELECT")
            || upper.starts_with("SHOW")
            || upper.starts_with("DESCRIBE")
            || upper.starts_with("DESC")
            || upper.starts_with("WITH")
            || upper.starts_with("EXPLAIN")
            || upper.starts_with("TABLE ")
    }
}

pub const MYSQL_DIALECT: MySqlDialect = MySqlDialect;

impl PostgresDialect {
    pub fn identifier(&self, name: &str) -> String {
        format!("\"{}\"", name.replace('"', "\"\""))
    }

    pub fn string_literal(&self, value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }

    pub fn table_ref(&self, schema: &str, table: &str) -> String {
        format!("{}.{}", self.identifier(schema), self.identifier(table))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn paginated_select(
        &self,
        columns_sql: &str,
        schema: &str,
        table: &str,
        where_sql: &str,
        order_sql: &str,
        limit: u64,
        offset: u64,
    ) -> String {
        format!(
            "SELECT {} FROM {}{}{} LIMIT {} OFFSET {}",
            columns_sql,
            self.table_ref(schema, table),
            where_sql,
            order_sql,
            limit,
            offset
        )
    }

    pub fn count_query(&self, schema: &str, table: &str, where_sql: &str) -> String {
        format!(
            "SELECT COUNT(*) as cnt FROM {}{}",
            self.table_ref(schema, table),
            where_sql
        )
    }

    pub fn sql_editor_allowed_on_read_only_connection(&self, sql: &str) -> bool {
        self.sql_editor_returns_result_set(sql)
    }

    fn sql_editor_returns_result_set(&self, sql: &str) -> bool {
        let upper = sql.trim().to_uppercase();
        if upper.starts_with("WITH") {
            return !self.with_statement_contains_write(&upper);
        }
        upper.starts_with("SELECT")
            || upper.starts_with("SHOW")
            || upper.starts_with("EXPLAIN")
            || upper.starts_with("TABLE ")
            || upper.starts_with("VALUES")
    }

    fn with_statement_contains_write(&self, upper_sql: &str) -> bool {
        let normalized = upper_sql.split_whitespace().collect::<Vec<_>>().join(" ");
        let compact = normalized.replace("( ", "(");
        [
            " AS (INSERT ",
            " AS (UPDATE ",
            " AS (DELETE ",
            " AS (MERGE ",
            " AS MATERIALIZED (INSERT ",
            " AS MATERIALIZED (UPDATE ",
            " AS MATERIALIZED (DELETE ",
            " AS MATERIALIZED (MERGE ",
            " AS NOT MATERIALIZED (INSERT ",
            " AS NOT MATERIALIZED (UPDATE ",
            " AS NOT MATERIALIZED (DELETE ",
            " AS NOT MATERIALIZED (MERGE ",
        ]
        .iter()
        .any(|marker| compact.contains(marker))
    }
}

pub const POSTGRES_DIALECT: PostgresDialect = PostgresDialect;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postgres_identifier_uses_double_quotes_and_escapes_quotes() {
        assert_eq!(POSTGRES_DIALECT.identifier("user"), "\"user\"");
        assert_eq!(POSTGRES_DIALECT.identifier("a\"b"), "\"a\"\"b\"");
    }

    #[test]
    fn postgres_string_literal_escapes_single_quotes_without_backslash_rules() {
        assert_eq!(POSTGRES_DIALECT.string_literal("it's"), "'it''s'");
        assert_eq!(POSTGRES_DIALECT.string_literal(r"a\b"), r"'a\b'");
    }

    #[test]
    fn postgres_table_ref_uses_schema_and_table() {
        assert_eq!(
            POSTGRES_DIALECT.table_ref("public", "users"),
            "\"public\".\"users\""
        );
    }

    #[test]
    fn postgres_paginated_select_uses_limit_offset() {
        assert_eq!(
            POSTGRES_DIALECT.paginated_select(
                "\"id\", \"name\"",
                "public",
                "users",
                " WHERE active = true",
                " ORDER BY \"id\" DESC",
                20,
                40,
            ),
            "SELECT \"id\", \"name\" FROM \"public\".\"users\" WHERE active = true ORDER BY \"id\" DESC LIMIT 20 OFFSET 40"
        );
    }

    #[test]
    fn postgres_count_query_counts_schema_table_with_where() {
        assert_eq!(
            POSTGRES_DIALECT.count_query("sales", "orders", " WHERE status = 'paid'"),
            "SELECT COUNT(*) as cnt FROM \"sales\".\"orders\" WHERE status = 'paid'"
        );
    }

    #[test]
    fn postgres_read_only_sql_editor_allows_query_result_statements_only() {
        assert!(POSTGRES_DIALECT.sql_editor_allowed_on_read_only_connection("SELECT 1"));
        assert!(POSTGRES_DIALECT
            .sql_editor_allowed_on_read_only_connection("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(POSTGRES_DIALECT.sql_editor_allowed_on_read_only_connection("EXPLAIN SELECT 1"));
        assert!(POSTGRES_DIALECT.sql_editor_allowed_on_read_only_connection("SHOW search_path"));
        assert!(!POSTGRES_DIALECT.sql_editor_allowed_on_read_only_connection("USE mydb"));
        assert!(!POSTGRES_DIALECT
            .sql_editor_allowed_on_read_only_connection("INSERT INTO t VALUES (1)"));
        assert!(
            !POSTGRES_DIALECT.sql_editor_allowed_on_read_only_connection(
                "WITH changed AS (UPDATE users SET name = 'x' RETURNING id) SELECT * FROM changed"
            )
        );
    }
}
