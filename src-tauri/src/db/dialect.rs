#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MySqlDialect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PostgresDialect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SqliteDialect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SqlServerDialect;

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

impl SqliteDialect {
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
        let upper = sql.trim().to_uppercase();
        if upper.starts_with("WITH") {
            return self.with_statement_main_is_select(&upper)
                && !self.with_statement_contains_write(&upper);
        }
        upper.starts_with("SELECT")
            || upper.starts_with("EXPLAIN")
            || self.is_readonly_pragma(&upper)
    }

    fn is_readonly_pragma(&self, upper_sql: &str) -> bool {
        let allowed = [
            "PRAGMA DATABASE_LIST",
            "PRAGMA TABLE_LIST",
            "PRAGMA TABLE_INFO",
            "PRAGMA TABLE_XINFO",
            "PRAGMA INDEX_LIST",
            "PRAGMA INDEX_INFO",
            "PRAGMA INDEX_XINFO",
            "PRAGMA FOREIGN_KEY_LIST",
            "PRAGMA QUICK_CHECK",
            "PRAGMA INTEGRITY_CHECK",
        ];
        allowed.iter().any(|prefix| upper_sql.starts_with(prefix))
    }

    fn with_statement_contains_write(&self, upper_sql: &str) -> bool {
        let normalized = upper_sql.split_whitespace().collect::<Vec<_>>().join(" ");
        let compact = normalized.replace("( ", "(");
        [
            " AS (INSERT ",
            " AS (UPDATE ",
            " AS (DELETE ",
            " AS (REPLACE ",
            " AS MATERIALIZED (INSERT ",
            " AS MATERIALIZED (UPDATE ",
            " AS MATERIALIZED (DELETE ",
            " AS MATERIALIZED (REPLACE ",
            " AS NOT MATERIALIZED (INSERT ",
            " AS NOT MATERIALIZED (UPDATE ",
            " AS NOT MATERIALIZED (DELETE ",
            " AS NOT MATERIALIZED (REPLACE ",
        ]
        .iter()
        .any(|marker| compact.contains(marker))
    }

    fn with_statement_main_is_select(&self, upper_sql: &str) -> bool {
        let Some(mut idx) = self.consume_keyword(upper_sql, 0, "WITH") else {
            return false;
        };
        idx = self.skip_ws(upper_sql, idx);
        if let Some(next) = self.consume_keyword(upper_sql, idx, "RECURSIVE") {
            idx = self.skip_ws(upper_sql, next);
        }

        loop {
            idx = self.skip_ws(upper_sql, idx);
            let Some(next) = self.skip_identifier(upper_sql, idx) else {
                return false;
            };
            idx = self.skip_ws(upper_sql, next);

            if upper_sql.as_bytes().get(idx) == Some(&b'(') {
                let Some(next) = self.skip_balanced_parentheses(upper_sql, idx) else {
                    return false;
                };
                idx = self.skip_ws(upper_sql, next);
            }

            let Some(next) = self.consume_keyword(upper_sql, idx, "AS") else {
                return false;
            };
            idx = self.skip_ws(upper_sql, next);

            if let Some(next) = self.consume_keyword(upper_sql, idx, "NOT") {
                idx = self.skip_ws(upper_sql, next);
                let Some(next) = self.consume_keyword(upper_sql, idx, "MATERIALIZED") else {
                    return false;
                };
                idx = self.skip_ws(upper_sql, next);
            } else if let Some(next) = self.consume_keyword(upper_sql, idx, "MATERIALIZED") {
                idx = self.skip_ws(upper_sql, next);
            }

            if upper_sql.as_bytes().get(idx) != Some(&b'(') {
                return false;
            }
            let Some(next) = self.skip_balanced_parentheses(upper_sql, idx) else {
                return false;
            };
            idx = self.skip_ws(upper_sql, next);

            if upper_sql.as_bytes().get(idx) == Some(&b',') {
                idx += 1;
                continue;
            }
            break;
        }

        upper_sql[idx..].trim_start().starts_with("SELECT")
    }

    fn consume_keyword(&self, sql: &str, idx: usize, keyword: &str) -> Option<usize> {
        let rest = sql.get(idx..)?;
        if !rest.starts_with(keyword) {
            return None;
        }
        let end = idx + keyword.len();
        match sql.as_bytes().get(end) {
            Some(b) if b.is_ascii_alphanumeric() || *b == b'_' => None,
            _ => Some(end),
        }
    }

    fn skip_ws(&self, sql: &str, mut idx: usize) -> usize {
        let bytes = sql.as_bytes();
        while bytes.get(idx).is_some_and(|b| b.is_ascii_whitespace()) {
            idx += 1;
        }
        idx
    }

    fn skip_identifier(&self, sql: &str, idx: usize) -> Option<usize> {
        match sql.as_bytes().get(idx)? {
            b'"' | b'`' => self.skip_quoted(sql, idx, *sql.as_bytes().get(idx)?),
            b'[' => self.skip_bracket_quoted(sql, idx),
            _ => {
                let bytes = sql.as_bytes();
                let mut end = idx;
                while bytes
                    .get(end)
                    .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'$')
                {
                    end += 1;
                }
                if end == idx {
                    None
                } else {
                    Some(end)
                }
            }
        }
    }

    fn skip_balanced_parentheses(&self, sql: &str, idx: usize) -> Option<usize> {
        let bytes = sql.as_bytes();
        if bytes.get(idx) != Some(&b'(') {
            return None;
        }

        let mut depth = 0usize;
        let mut i = idx;
        while i < bytes.len() {
            match bytes[i] {
                b'\'' | b'"' | b'`' => {
                    i = self.skip_quoted(sql, i, bytes[i])?;
                    continue;
                }
                b'[' => {
                    i = self.skip_bracket_quoted(sql, i)?;
                    continue;
                }
                b'(' => depth += 1,
                b')' => {
                    depth = depth.checked_sub(1)?;
                    if depth == 0 {
                        return Some(i + 1);
                    }
                }
                _ => {}
            }
            i += 1;
        }
        None
    }

    fn skip_quoted(&self, sql: &str, idx: usize, quote: u8) -> Option<usize> {
        let bytes = sql.as_bytes();
        if bytes.get(idx) != Some(&quote) {
            return None;
        }
        let mut i = idx + 1;
        while i < bytes.len() {
            if bytes[i] == quote {
                if bytes.get(i + 1) == Some(&quote) {
                    i += 2;
                    continue;
                }
                return Some(i + 1);
            }
            i += 1;
        }
        None
    }

    fn skip_bracket_quoted(&self, sql: &str, idx: usize) -> Option<usize> {
        let bytes = sql.as_bytes();
        if bytes.get(idx) != Some(&b'[') {
            return None;
        }
        let mut i = idx + 1;
        while i < bytes.len() {
            if bytes[i] == b']' {
                return Some(i + 1);
            }
            i += 1;
        }
        None
    }
}

pub const SQLITE_DIALECT: SqliteDialect = SqliteDialect;

impl SqlServerDialect {
    pub fn identifier(&self, name: &str) -> String {
        format!("[{}]", name.replace(']', "]]"))
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
        let order_sql = if order_sql.trim().is_empty() {
            " ORDER BY (SELECT 0)"
        } else {
            order_sql
        };
        format!(
            "SELECT {} FROM {}{}{} OFFSET {} ROWS FETCH NEXT {} ROWS ONLY",
            columns_sql,
            self.table_ref(schema, table),
            where_sql,
            order_sql,
            offset,
            limit
        )
    }

    pub fn count_query(&self, schema: &str, table: &str, where_sql: &str) -> String {
        format!(
            "SELECT COUNT_BIG(*) as cnt FROM {}{}",
            self.table_ref(schema, table),
            where_sql
        )
    }

    pub fn sql_editor_allowed_on_read_only_connection(&self, sql: &str) -> bool {
        self.sql_editor_returns_result_set(sql)
    }

    pub fn sql_editor_returns_result_set(&self, sql: &str) -> bool {
        let upper = self.trim_leading_statement_separators(sql).to_uppercase();
        if upper.is_empty() {
            return false;
        }
        if self.showplan_statement_is_readonly(&upper) {
            return true;
        }
        if self.starts_with_keyword(&upper, "WITH") {
            let Some(main_select_idx) = self.with_statement_main_select_start(&upper) else {
                return false;
            };
            return !self.with_statement_contains_write(&upper)
                && !self.select_statement_contains_write(&upper[main_select_idx..]);
        }
        if self.starts_with_keyword(&upper, "SELECT") {
            return !self.select_statement_contains_write(&upper);
        }
        self.starts_with_keyword(&upper, "EXPLAIN")
    }

    fn trim_leading_statement_separators<'a>(&self, sql: &'a str) -> &'a str {
        sql.trim_start().trim_start_matches(';').trim_start()
    }

    fn showplan_statement_is_readonly(&self, upper_sql: &str) -> bool {
        let statements = upper_sql
            .split(';')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        if statements.len() < 3 {
            return false;
        }

        let first = statements.first().copied().unwrap_or_default();
        let last = statements.last().copied().unwrap_or_default();
        let showplan_text = first == "SET SHOWPLAN_TEXT ON" && last == "SET SHOWPLAN_TEXT OFF";
        let showplan_xml = first == "SET SHOWPLAN_XML ON" && last == "SET SHOWPLAN_XML OFF";
        if !showplan_text && !showplan_xml {
            return false;
        }

        let inner = statements[1..statements.len() - 1].join("; ");
        self.sql_editor_returns_result_set(&inner)
    }

    fn select_statement_contains_write(&self, upper_sql: &str) -> bool {
        let normalized = upper_sql.split_whitespace().collect::<Vec<_>>().join(" ");
        let padded = format!(" {} ", normalized);
        padded.contains(" INTO ")
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

    fn with_statement_main_select_start(&self, upper_sql: &str) -> Option<usize> {
        let Some(mut idx) = self.consume_keyword(upper_sql, 0, "WITH") else {
            return None;
        };

        loop {
            idx = self.skip_ws(upper_sql, idx);
            let Some(next) = self.skip_identifier(upper_sql, idx) else {
                return None;
            };
            idx = self.skip_ws(upper_sql, next);

            if upper_sql.as_bytes().get(idx) == Some(&b'(') {
                let Some(next) = self.skip_balanced_parentheses(upper_sql, idx) else {
                    return None;
                };
                idx = self.skip_ws(upper_sql, next);
            }

            let Some(next) = self.consume_keyword(upper_sql, idx, "AS") else {
                return None;
            };
            idx = self.skip_ws(upper_sql, next);

            if upper_sql.as_bytes().get(idx) != Some(&b'(') {
                return None;
            }
            let Some(next) = self.skip_balanced_parentheses(upper_sql, idx) else {
                return None;
            };
            idx = self.skip_ws(upper_sql, next);

            if upper_sql.as_bytes().get(idx) == Some(&b',') {
                idx += 1;
                continue;
            }
            break;
        }

        let main_sql = upper_sql[idx..].trim_start();
        if self.starts_with_keyword(main_sql, "SELECT") {
            Some(upper_sql.len() - main_sql.len())
        } else {
            None
        }
    }

    fn starts_with_keyword(&self, sql: &str, keyword: &str) -> bool {
        self.consume_keyword(sql, 0, keyword).is_some()
    }

    fn consume_keyword(&self, sql: &str, idx: usize, keyword: &str) -> Option<usize> {
        let rest = sql.get(idx..)?;
        if !rest.starts_with(keyword) {
            return None;
        }
        let end = idx + keyword.len();
        match sql.as_bytes().get(end) {
            Some(b) if b.is_ascii_alphanumeric() || *b == b'_' => None,
            _ => Some(end),
        }
    }

    fn skip_ws(&self, sql: &str, mut idx: usize) -> usize {
        let bytes = sql.as_bytes();
        while bytes.get(idx).is_some_and(|b| b.is_ascii_whitespace()) {
            idx += 1;
        }
        idx
    }

    fn skip_identifier(&self, sql: &str, idx: usize) -> Option<usize> {
        match sql.as_bytes().get(idx)? {
            b'"' | b'\'' => self.skip_quoted(sql, idx, *sql.as_bytes().get(idx)?),
            b'[' => self.skip_bracket_quoted(sql, idx),
            _ => {
                let bytes = sql.as_bytes();
                let mut end = idx;
                while bytes
                    .get(end)
                    .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'$')
                {
                    end += 1;
                }
                if end == idx {
                    None
                } else {
                    Some(end)
                }
            }
        }
    }

    fn skip_balanced_parentheses(&self, sql: &str, idx: usize) -> Option<usize> {
        let bytes = sql.as_bytes();
        if bytes.get(idx) != Some(&b'(') {
            return None;
        }

        let mut depth = 0usize;
        let mut i = idx;
        while i < bytes.len() {
            match bytes[i] {
                b'\'' | b'"' => {
                    i = self.skip_quoted(sql, i, bytes[i])?;
                    continue;
                }
                b'[' => {
                    i = self.skip_bracket_quoted(sql, i)?;
                    continue;
                }
                b'(' => depth += 1,
                b')' => {
                    depth = depth.checked_sub(1)?;
                    if depth == 0 {
                        return Some(i + 1);
                    }
                }
                _ => {}
            }
            i += 1;
        }
        None
    }

    fn skip_quoted(&self, sql: &str, idx: usize, quote: u8) -> Option<usize> {
        let bytes = sql.as_bytes();
        if bytes.get(idx) != Some(&quote) {
            return None;
        }
        let mut i = idx + 1;
        while i < bytes.len() {
            if bytes[i] == quote {
                if bytes.get(i + 1) == Some(&quote) {
                    i += 2;
                    continue;
                }
                return Some(i + 1);
            }
            i += 1;
        }
        None
    }

    fn skip_bracket_quoted(&self, sql: &str, idx: usize) -> Option<usize> {
        let bytes = sql.as_bytes();
        if bytes.get(idx) != Some(&b'[') {
            return None;
        }
        let mut i = idx + 1;
        while i < bytes.len() {
            if bytes[i] == b']' {
                if bytes.get(i + 1) == Some(&b']') {
                    i += 2;
                    continue;
                }
                return Some(i + 1);
            }
            i += 1;
        }
        None
    }
}

pub const SQLSERVER_DIALECT: SqlServerDialect = SqlServerDialect;

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
    fn sqlite_identifier_uses_double_quotes_and_escapes_quotes() {
        assert_eq!(SQLITE_DIALECT.identifier("user"), "\"user\"");
        assert_eq!(SQLITE_DIALECT.identifier("a\"b"), "\"a\"\"b\"");
    }

    #[test]
    fn sqlite_table_ref_uses_schema_and_table() {
        assert_eq!(
            SQLITE_DIALECT.table_ref("main", "users"),
            "\"main\".\"users\""
        );
    }

    #[test]
    fn sqlite_paginated_select_uses_limit_offset() {
        assert_eq!(
            SQLITE_DIALECT.paginated_select(
                "\"id\", \"name\"",
                "main",
                "users",
                " WHERE \"active\" = 1",
                " ORDER BY \"id\" DESC",
                20,
                40,
            ),
            "SELECT \"id\", \"name\" FROM \"main\".\"users\" WHERE \"active\" = 1 ORDER BY \"id\" DESC LIMIT 20 OFFSET 40"
        );
    }

    #[test]
    fn sqlite_count_query_counts_schema_table_with_where() {
        assert_eq!(
            SQLITE_DIALECT.count_query("main", "users", " WHERE \"name\" = 'Alice'"),
            "SELECT COUNT(*) as cnt FROM \"main\".\"users\" WHERE \"name\" = 'Alice'"
        );
    }

    #[test]
    fn sqlite_read_only_sql_editor_allows_safe_read_statements_only() {
        assert!(SQLITE_DIALECT.sql_editor_allowed_on_read_only_connection("SELECT 1"));
        assert!(SQLITE_DIALECT.sql_editor_allowed_on_read_only_connection("EXPLAIN SELECT 1"));
        assert!(
            SQLITE_DIALECT.sql_editor_allowed_on_read_only_connection("PRAGMA table_info(users)")
        );

        assert!(
            !SQLITE_DIALECT.sql_editor_allowed_on_read_only_connection("PRAGMA journal_mode=WAL")
        );
        assert!(!SQLITE_DIALECT.sql_editor_allowed_on_read_only_connection("ATTACH 'x' AS aux"));
        assert!(!SQLITE_DIALECT.sql_editor_allowed_on_read_only_connection("VACUUM"));
        assert!(!SQLITE_DIALECT
            .sql_editor_allowed_on_read_only_connection("INSERT INTO users VALUES (1)"));
        assert!(!SQLITE_DIALECT.sql_editor_allowed_on_read_only_connection(
            "WITH x AS (SELECT 1) INSERT INTO users SELECT * FROM x"
        ));
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

    #[test]
    fn sqlserver_identifier_uses_brackets_and_escapes_closing_brackets() {
        assert_eq!(SQLSERVER_DIALECT.identifier("user"), "[user]");
        assert_eq!(SQLSERVER_DIALECT.identifier("a]b"), "[a]]b]");
    }

    #[test]
    fn sqlserver_string_literal_escapes_single_quotes() {
        assert_eq!(SQLSERVER_DIALECT.string_literal("it's"), "'it''s'");
        assert_eq!(SQLSERVER_DIALECT.string_literal(r"a\b"), r"'a\b'");
    }

    #[test]
    fn sqlserver_paginated_select_uses_offset_fetch() {
        assert_eq!(
            SQLSERVER_DIALECT.paginated_select(
                "[id], [name]",
                "dbo",
                "users",
                " WHERE [active] = 1",
                " ORDER BY [id] DESC",
                20,
                40,
            ),
            "SELECT [id], [name] FROM [dbo].[users] WHERE [active] = 1 ORDER BY [id] DESC OFFSET 40 ROWS FETCH NEXT 20 ROWS ONLY"
        );
    }

    #[test]
    fn sqlserver_paginated_select_adds_fallback_order_when_empty() {
        assert_eq!(
            SQLSERVER_DIALECT.paginated_select("*", "dbo", "users", "", "", 10, 0),
            "SELECT * FROM [dbo].[users] ORDER BY (SELECT 0) OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY"
        );
    }

    #[test]
    fn sqlserver_count_query_counts_schema_table_with_where() {
        assert_eq!(
            SQLSERVER_DIALECT.count_query("sales", "orders", " WHERE [status] = 'paid'"),
            "SELECT COUNT_BIG(*) as cnt FROM [sales].[orders] WHERE [status] = 'paid'"
        );
    }

    #[test]
    fn sqlserver_read_only_sql_editor_allows_safe_read_statements_only() {
        assert!(SQLSERVER_DIALECT.sql_editor_allowed_on_read_only_connection("SELECT 1"));
        assert!(SQLSERVER_DIALECT
            .sql_editor_allowed_on_read_only_connection("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(
            SQLSERVER_DIALECT.sql_editor_allowed_on_read_only_connection(
                "SET SHOWPLAN_TEXT ON; SELECT * FROM users; SET SHOWPLAN_TEXT OFF"
            )
        );
        assert!(SQLSERVER_DIALECT
            .sql_editor_allowed_on_read_only_connection("SELECT * FROM sys.tables"));

        for sql in [
            "INSERT INTO users(id) VALUES (1)",
            "UPDATE users SET name = 'x'",
            "DELETE FROM users",
            "MERGE dbo.users AS target USING dbo.tmp AS source ON 1 = 1 WHEN MATCHED THEN UPDATE SET name = source.name",
            "TRUNCATE TABLE users",
            "DROP TABLE users",
            "ALTER TABLE users ADD note nvarchar(100)",
            "CREATE TABLE users(id int)",
            "EXEC sp_who2",
            "WITH changed AS (UPDATE users SET name = 'x' OUTPUT inserted.id) SELECT * FROM changed",
            "WITH x AS (SELECT 1) DELETE FROM users",
            "WITH x AS (SELECT 1 AS id) SELECT * INTO new_users FROM x",
        ] {
            assert!(
                !SQLSERVER_DIALECT.sql_editor_allowed_on_read_only_connection(sql),
                "{sql} should be rejected on read-only connections"
            );
        }
    }
}
