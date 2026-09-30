//! MySQL 8 空目录补验。只解析同一连接裸 SHOW GRANTS 的有效授权，不查询额外权限表。
use std::collections::BTreeSet;

// 对应 MySQL DB_OP_ACLS；SHOW DATABASES、USAGE、动态管理权限不授予库操作权。
const DB_OPERATIONS: &[&str] = &[
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "CREATE",
    "DROP",
    "REFERENCES",
    "INDEX",
    "ALTER",
    "CREATE TEMPORARY TABLES",
    "LOCK TABLES",
    "EXECUTE",
    "CREATE VIEW",
    "SHOW VIEW",
    "CREATE ROUTINE",
    "ALTER ROUTINE",
    "EVENT",
    "TRIGGER",
];

#[derive(Debug, PartialEq)]
enum Token {
    Word(String),
    Quoted(String),
    Symbol(char),
}

fn tokens(input: &str) -> Result<Vec<Token>, String> {
    let mut chars = input.chars().peekable();
    let mut result = Vec::new();
    while let Some(ch) = chars.next() {
        if ch.is_whitespace() {
            continue;
        }
        if matches!(ch, '`' | '"' | '\'') {
            let mut value = String::new();
            let mut closed = false;
            while let Some(next) = chars.next() {
                if next == ch {
                    if chars.peek() == Some(&ch) {
                        chars.next();
                        value.push(ch);
                    } else {
                        closed = true;
                        break;
                    }
                } else {
                    value.push(next);
                }
            }
            if !closed {
                return Err("授权标识符未闭合".into());
            }
            result.push(Token::Quoted(value));
        } else if matches!(ch, '*' | '.' | ',' | '(' | ')' | '@') {
            result.push(Token::Symbol(ch));
        } else {
            let mut word = String::from(ch);
            while chars.peek().is_some_and(|next| {
                !next.is_whitespace()
                    && !matches!(next, '`' | '"' | '\'' | '*' | '.' | ',' | '(' | ')' | '@')
            }) {
                word.push(chars.next().unwrap());
            }
            result.push(Token::Word(word));
        }
    }
    Ok(result)
}

fn word(token: &Token, expected: &str) -> bool {
    matches!(token, Token::Word(value) if value.eq_ignore_ascii_case(expected))
}

fn privileges(tokens: &[Token]) -> Result<BTreeSet<String>, String> {
    let mut parts = Vec::new();
    let mut current = Vec::new();
    let mut depth = 0usize;
    for token in tokens {
        match token {
            Token::Symbol('(') => depth += 1,
            Token::Symbol(')') => {
                depth = depth.checked_sub(1).ok_or("授权列列表无效")?;
            }
            Token::Symbol(',') if depth == 0 => {
                parts.push(current.join(" "));
                current.clear();
            }
            Token::Word(value) if depth == 0 => current.push(value.to_ascii_uppercase()),
            _ if depth > 0 => {}
            _ => return Err("授权权限列表无法解析".into()),
        }
    }
    if depth != 0 {
        return Err("授权列列表未闭合".into());
    }
    parts.push(current.join(" "));
    if parts.iter().any(String::is_empty) {
        return Err("授权权限列表为空".into());
    }
    if parts.iter().any(|value| value == "ALL PRIVILEGES") {
        return Ok(DB_OPERATIONS.iter().map(|value| (*value).into()).collect());
    }
    Ok(parts
        .into_iter()
        .filter(|value| DB_OPERATIONS.contains(&value.as_str()))
        .collect())
}

#[derive(Debug)]
struct Grant {
    revoked: bool,
    database: Option<String>,
    object: bool,
    privileges: BTreeSet<String>,
    grant_option: bool,
}

fn parse(line: &str) -> Result<Option<Grant>, String> {
    let tokens = tokens(line)?;
    let revoked = tokens.first().is_some_and(|token| word(token, "REVOKE"));
    if !revoked && !tokens.first().is_some_and(|token| word(token, "GRANT")) {
        return Err("无法识别授权行".into());
    }
    let Some(on) = tokens.iter().position(|token| word(token, "ON")) else {
        // 角色分配行不含 ON；裸 SHOW GRANTS 已在其他行展开当前启用角色。
        if !revoked && matches!(tokens.get(1), Some(Token::Quoted(_))) {
            return Ok(None);
        }
        return Err("无法识别授权范围".into());
    };
    if tokens.get(1).is_some_and(|token| word(token, "PROXY")) {
        return Ok(None);
    }
    let privileges = privileges(&tokens[1..on])?;
    let mut scope = on + 1;
    if tokens
        .get(scope)
        .is_some_and(|token| word(token, "PROCEDURE") || word(token, "FUNCTION"))
    {
        scope += 1;
    }
    let database = match tokens.get(scope) {
        Some(Token::Symbol('*')) => None,
        Some(Token::Quoted(value)) | Some(Token::Word(value)) => Some(value.clone()),
        _ => return Err("无法识别授权数据库".into()),
    };
    if tokens.get(scope + 1) != Some(&Token::Symbol('.')) {
        return Err("无法识别授权对象".into());
    }
    let object = match tokens.get(scope + 2) {
        Some(Token::Symbol('*')) => false,
        Some(Token::Quoted(_)) | Some(Token::Word(_)) => true,
        _ => return Err("无法识别授权对象".into()),
    };
    let terminator = if revoked { "FROM" } else { "TO" };
    if !tokens
        .get(scope + 3)
        .is_some_and(|token| word(token, terminator))
    {
        return Err("无法识别授权终点".into());
    }
    let grant_option = tokens.windows(3).any(|window| {
        word(&window[0], "WITH") && word(&window[1], "GRANT") && word(&window[2], "OPTION")
    });
    if revoked && (database.is_none() || object) {
        return Err("无法识别局部撤权范围".into());
    }
    Ok(Some(Grant {
        revoked,
        database,
        object,
        privileges,
        grant_option,
    }))
}

fn database_matches(pattern: &str, database: &str, literal: bool, lowercase: bool) -> bool {
    let (pattern, database) = if lowercase {
        (pattern.to_lowercase(), database.to_lowercase())
    } else {
        (pattern.to_string(), database.to_string())
    };
    if literal {
        return pattern == database;
    }
    // 仅内存通配符匹配；数据库名至多 64 字符。
    let value: Vec<char> = database.chars().collect();
    let mut state = vec![false; value.len() + 1];
    state[0] = true;
    let mut chars = pattern.chars();
    while let Some(ch) = chars.next() {
        let escaped = ch == '\\';
        let ch = if escaped {
            chars.next().unwrap_or('\\')
        } else {
            ch
        };
        let mut next = vec![false; value.len() + 1];
        if ch == '%' && !escaped {
            next[0] = state[0];
            for index in 1..=value.len() {
                next[index] = state[index] || next[index - 1];
            }
        } else {
            for index in 1..=value.len() {
                next[index] =
                    state[index - 1] && ((ch == '_' && !escaped) || value[index - 1] == ch);
            }
        }
        state = next;
    }
    state[value.len()]
}

pub(super) fn validate_empty_databases(
    lines: &[String],
    databases: &[&str],
    lowercase: bool,
    literal_database_grants: bool,
) -> Result<(), String> {
    let grants: Vec<Grant> = lines
        .iter()
        .map(|line| parse(line))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "无法验证空目录访问权限：服务器授权格式无法识别".to_string())?
        .into_iter()
        .flatten()
        .collect();
    if grants.is_empty() {
        return Err("无法验证空目录访问权限：服务器未返回有效授权".into());
    }
    for database in databases {
        let mut global = BTreeSet::new();
        let mut local = false;
        let mut object_access = false;
        let mut schema_allows = false;
        let mut schema_without_operations = false;
        for grant in grants.iter().filter(|grant| !grant.revoked) {
            match &grant.database {
                None => global.extend(grant.privileges.iter().cloned()),
                Some(pattern)
                    if database_matches(
                        pattern,
                        database,
                        grant.object || literal_database_grants,
                        lowercase,
                    ) =>
                {
                    let allows =
                        !grant.privileges.is_empty() || (grant.object && grant.grant_option);
                    local |= allows;
                    if grant.object {
                        object_access |= allows;
                    } else {
                        schema_allows |= allows;
                        schema_without_operations |= !allows;
                    }
                }
                _ => {}
            }
        }
        // 部分撤权只扣除全局权限，不覆盖独立的库/表/列/例程授权。
        for grant in grants.iter().filter(|grant| grant.revoked) {
            if grant
                .database
                .as_ref()
                .is_some_and(|name| database_matches(name, database, true, lowercase))
            {
                global.retain(|privilege| !grant.privileges.contains(privilege));
            }
        }
        // 无活动角色时服务器按匹配优先级选择库授权，不能将精确 USAGE
        // 与较宽的通配符 CREATE 简单合并。缺少排序证据时明确拒绝验证；
        // 独立的全局或对象操作权仍可直接证明访问，不受此歧义影响。
        if !literal_database_grants
            && global.is_empty()
            && !object_access
            && schema_allows
            && schema_without_operations
        {
            return Err(format!(
                "无法验证数据库 {database} 的空目录访问权限：库授权重叠"
            ));
        }
        if !local && global.is_empty() {
            return Err(format!("数据库 {database} 不存在或无权访问"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn access(lines: &[&str], db: &str, literal: bool) -> Result<(), String> {
        validate_empty_databases(
            &lines.iter().map(|line| (*line).into()).collect::<Vec<_>>(),
            &[db],
            false,
            literal,
        )
    }

    #[test]
    fn metadata_access_rejects_show_only_empty_role_and_global_grant_option() {
        assert!(access(&["GRANT SHOW DATABASES ON *.* TO `u`@`%`"], "empty", false).is_err());
        assert!(access(
            &[
                "GRANT USAGE ON *.* TO `u`@`%`",
                "GRANT `empty_role`@`%` TO `u`@`%`"
            ],
            "empty",
            false
        )
        .is_err());
        assert!(access(
            &["GRANT USAGE ON *.* TO `u`@`%` WITH GRANT OPTION"],
            "empty",
            false
        )
        .is_err());
        assert!(access(
            &["GRANT USAGE ON `empty`.* TO `u`@`%` WITH GRANT OPTION"],
            "empty",
            false
        )
        .is_err());
    }

    #[test]
    fn metadata_access_accepts_effective_schema_column_routine_and_table_grant_option() {
        assert!(access(
            &[
                "GRANT CREATE ON `empty`.* TO `u`@`%`",
                "GRANT `parent`@`%` TO `u`@`%`"
            ],
            "empty",
            false
        )
        .is_ok());
        assert!(access(
            &["GRANT SELECT (`col, ON x`, `b`) ON `empty`.`t` TO `u`@`%`"],
            "empty",
            false
        )
        .is_ok());
        assert!(access(
            &["GRANT EXECUTE ON PROCEDURE `empty`.`p` TO `u`@`%`"],
            "empty",
            false
        )
        .is_ok());
        assert!(access(
            &["GRANT ALTER ROUTINE ON FUNCTION `empty`.`f` TO `u`@`%`"],
            "empty",
            false
        )
        .is_ok());
        assert!(access(
            &["GRANT USAGE ON `empty`.`t` TO `u`@`%` WITH GRANT OPTION"],
            "empty",
            false
        )
        .is_ok());
    }

    #[test]
    fn metadata_access_partial_revoke_only_subtracts_global_privileges() {
        let global = "GRANT SELECT, CREATE, SHOW DATABASES ON *.* TO `u`@`%`";
        let revoke = "REVOKE SELECT, CREATE ON `empty`.* FROM `u`@`%`";
        assert!(access(&[global, revoke], "empty", true).is_err());
        assert!(access(&[global, revoke], "other", true).is_ok());
        assert!(access(
            &[global, revoke, "GRANT SELECT ON `empty`.`t` TO `u`@`%`"],
            "empty",
            true
        )
        .is_ok());
        assert!(access(
            &[global, "REVOKE SELECT ON `empty`.* FROM `u`@`%`"],
            "empty",
            true
        )
        .is_ok());
    }

    #[test]
    fn metadata_access_identifier_quoting_case_and_wildcard_modes() {
        assert!(access(
            &["GRANT CREATE ON `quote``.db`.* TO `u`@`%`"],
            "quote`.db",
            false
        )
        .is_ok());
        assert!(access(
            &["GRANT CREATE ON \"quote\"\".db\".* TO `u`@`%`"],
            "quote\".db",
            false
        )
        .is_ok());
        assert!(access(&["GRANT CREATE ON `Case`.* TO `u`@`%`"], "case", false).is_err());
        assert!(access(&["GRANT CREATE ON `meta_%`.* TO `u`@`%`"], "meta_x", false).is_ok());
        assert!(access(&["GRANT CREATE ON `meta_%`.* TO `u`@`%`"], "meta_x", true).is_err());
        assert!(access(&["GRANT CREATE ON `meta\\_%`.* TO `u`@`%`"], "metax", false).is_err());
        assert!(access(
            &["GRANT CREATE ON `meta\\_%`.* TO `u`@`%`"],
            "meta_x",
            false
        )
        .is_ok());
        assert!(validate_empty_databases(
            &["GRANT CREATE ON `Case`.* TO `u`@`%`".into()],
            &["case"],
            true,
            false
        )
        .is_ok());
    }

    #[test]
    fn metadata_access_unknown_format_fails_explicitly_and_other_management_grants_do_not_allow() {
        assert!(access(&["UNRECOGNIZED SERVER OUTPUT"], "empty", false)
            .unwrap_err()
            .contains("无法验证"));
        assert!(access(
            &["GRANT BACKUP_ADMIN, SYSTEM_USER ON *.* TO `u`@`%`"],
            "empty",
            false
        )
        .is_err());
        assert!(access(&["GRANT ALL PRIVILEGES ON *.* TO `u`@`%`"], "empty", false).is_ok());
        assert!(access(
            &[
                "GRANT CREATE ON `empty`.* TO `u`@`%`",
                "GRANT PROXY ON ''@'' TO `u`@`%`"
            ],
            "empty",
            false
        )
        .is_ok());
    }

    #[test]
    fn metadata_access_overlapping_schema_grants_do_not_override_exact_usage() {
        let show = "GRANT SHOW DATABASES ON *.* TO `u`@`%`";
        let broad = "GRANT CREATE ON `probe%`.* TO `u`@`%`";
        let exact = "GRANT USAGE ON `probeexact`.* TO `u`@`%` WITH GRANT OPTION";
        assert!(access(&[show, broad, exact], "probeexact", false)
            .unwrap_err()
            .contains("授权重叠"));
        assert!(access(&[exact, broad, show], "probeexact", false)
            .unwrap_err()
            .contains("授权重叠"));
        assert!(access(&[show, broad, exact], "probeother", false).is_ok());
        assert!(access(&[show, broad, exact], "probeexact", true).is_err());
        assert!(access(
            &[show, broad, exact, "GRANT SELECT ON *.* TO `u`@`%`"],
            "probeexact",
            false
        )
        .is_ok());
        assert!(access(
            &[
                show,
                broad,
                exact,
                "GRANT SELECT ON `probeexact`.`t` TO `u`@`%`"
            ],
            "probeexact",
            false
        )
        .is_ok());
    }
}
