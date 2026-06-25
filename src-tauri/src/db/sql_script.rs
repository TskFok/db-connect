//! 将 SQL 脚本拆成单条语句（与前端 `splitSqlStatements` 行为一致：分号分隔，尊重引号/反引号、行注释与块注释）。

/// 按分号拆分语句，忽略：
/// - 单引号、双引号、反引号字符串内的分号  
/// - `--` / `#` 行注释与 `/* */` 块注释内的分号
pub fn split_sql_statements(sql: &str) -> Vec<String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    let mut result: Vec<String> = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = trimmed.chars().collect();
    let mut i = 0usize;
    let mut in_single = false;
    let mut in_double = false;
    let mut in_backtick = false;
    let mut dollar_quote_tag: Option<String> = None;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut escaped = false;

    while i < chars.len() {
        let c = chars[i];
        if let Some(tag) = dollar_quote_tag.as_ref() {
            if starts_with_chars(&chars, i, tag) {
                current.push_str(tag);
                i += tag.chars().count();
                dollar_quote_tag = None;
            } else {
                current.push(c);
                i += 1;
            }
            continue;
        }
        if in_line_comment {
            current.push(c);
            if c == '\n' {
                in_line_comment = false;
            }
            i += 1;
            continue;
        }
        if in_block_comment {
            if c == '*' && i + 1 < chars.len() && chars[i + 1] == '/' {
                current.push('*');
                current.push('/');
                in_block_comment = false;
                i += 2;
            } else {
                current.push(c);
                i += 1;
            }
            continue;
        }
        if escaped {
            current.push(c);
            escaped = false;
            i += 1;
            continue;
        }
        if c == '\\' && (in_single || in_double) {
            escaped = true;
            current.push(c);
            i += 1;
            continue;
        }
        if !in_single && !in_double && !in_backtick {
            if c == '-' && i + 1 < chars.len() && chars[i + 1] == '-' {
                current.push('-');
                current.push('-');
                in_line_comment = true;
                i += 2;
                continue;
            }
            if c == '#' {
                current.push(c);
                in_line_comment = true;
                i += 1;
                continue;
            }
            if c == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
                current.push('/');
                current.push('*');
                in_block_comment = true;
                i += 2;
                continue;
            }
            if c == '\'' {
                in_single = true;
                current.push(c);
                i += 1;
                continue;
            }
            if c == '"' {
                in_double = true;
                current.push(c);
                i += 1;
                continue;
            }
            if c == '`' {
                in_backtick = true;
                current.push(c);
                i += 1;
                continue;
            }
            if c == '$' {
                if let Some(tag) = parse_dollar_quote_tag(&chars, i) {
                    current.push_str(&tag);
                    i += tag.chars().count();
                    dollar_quote_tag = Some(tag);
                    continue;
                }
            }
            if c == ';' {
                let stmt = current.trim();
                if !stmt.is_empty() {
                    result.push(stmt.to_string());
                }
                current.clear();
                i += 1;
                continue;
            }
        } else {
            if c == '\'' && in_single {
                in_single = false;
            }
            if c == '"' && in_double {
                in_double = false;
            }
            if c == '`' && in_backtick {
                in_backtick = false;
            }
        }
        current.push(c);
        i += 1;
    }
    let last = current.trim();
    if !last.is_empty() {
        result.push(last.to_string());
    }
    result
}

fn starts_with_chars(chars: &[char], start: usize, expected: &str) -> bool {
    let expected_chars: Vec<char> = expected.chars().collect();
    if start + expected_chars.len() > chars.len() {
        return false;
    }
    chars[start..start + expected_chars.len()] == expected_chars[..]
}

fn parse_dollar_quote_tag(chars: &[char], start: usize) -> Option<String> {
    if chars.get(start) != Some(&'$') {
        return None;
    }
    let mut end = start + 1;
    while end < chars.len() && chars[end] != '$' {
        end += 1;
    }
    if end >= chars.len() {
        return None;
    }
    let tag_body = &chars[start + 1..end];
    let valid = if tag_body.is_empty() {
        true
    } else {
        tag_body
            .first()
            .map(|c| c.is_ascii_alphabetic() || *c == '_')
            .unwrap_or(false)
            && tag_body
                .iter()
                .all(|c| c.is_ascii_alphanumeric() || *c == '_')
    };
    if !valid {
        return None;
    }
    Some(chars[start..=end].iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_statement() {
        assert_eq!(split_sql_statements("SELECT 1"), vec!["SELECT 1"]);
    }

    #[test]
    fn two_statements() {
        assert_eq!(
            split_sql_statements("SELECT 1; SELECT 2"),
            vec!["SELECT 1", "SELECT 2"]
        );
    }

    #[test]
    fn semicolon_in_string() {
        assert_eq!(
            split_sql_statements("INSERT INTO t VALUES ('a;b')"),
            vec!["INSERT INTO t VALUES ('a;b')"]
        );
    }

    #[test]
    fn empty_and_whitespace() {
        assert!(split_sql_statements("").is_empty());
        assert!(split_sql_statements("   ").is_empty());
        assert_eq!(
            split_sql_statements("SELECT 1;\n\n  SELECT 2;"),
            vec!["SELECT 1", "SELECT 2"]
        );
    }

    #[test]
    fn semicolon_in_backtick() {
        assert_eq!(
            split_sql_statements("SELECT `col;name` FROM t"),
            vec!["SELECT `col;name` FROM t"]
        );
    }

    #[test]
    fn semicolon_in_line_comment() {
        assert_eq!(
            split_sql_statements("-- hint USE db;\nSELECT 1"),
            vec!["-- hint USE db;\nSELECT 1"]
        );
    }

    #[test]
    fn semicolon_in_block_comment() {
        assert_eq!(
            split_sql_statements("SELECT /* ; */ 1; SELECT 2"),
            vec!["SELECT /* ; */ 1", "SELECT 2"]
        );
    }

    #[test]
    fn double_hyphen_inside_string_not_comment() {
        assert_eq!(
            split_sql_statements("SELECT '-- not; comment' AS x"),
            vec!["SELECT '-- not; comment' AS x"]
        );
    }

    #[test]
    fn semicolon_inside_postgres_dollar_quote() {
        let sql = r#"
CREATE FUNCTION public.touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_touch BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
"#;
        assert_eq!(
            split_sql_statements(sql),
            vec![
                "CREATE FUNCTION public.touch_updated_at() RETURNS trigger AS $$\nBEGIN\n  NEW.updated_at = now();\n  RETURN NEW;\nEND;\n$$ LANGUAGE plpgsql",
                "CREATE TRIGGER users_touch BEFORE UPDATE ON public.users\nFOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()"
            ]
        );
    }
}
