//! MySQL 表浏览的大字段投影及完整值回查。所有计划都只生成单次集合查询。
use crate::db::sql_utils::esc_id;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug)]
pub struct MysqlColumn {
    pub name: String,
    pub data_type: String,
    pub unsigned: bool,
    pub invisible: bool,
}

impl MysqlColumn {
    fn deferred_kind(&self) -> Option<&'static str> {
        match self.data_type.as_str() {
            "char" | "varchar" | "tinytext" | "text" | "mediumtext" | "longtext" | "json" => {
                Some("text")
            }
            "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" => {
                Some("binary")
            }
            _ => None,
        }
    }
    fn can_locate(&self) -> bool {
        // 仅允许现有 JSON 展示转换可无损往返的主键；小数、时间和二进制保守回退。
        matches!(
            self.data_type.as_str(),
            "tinyint"
                | "smallint"
                | "mediumint"
                | "int"
                | "bigint"
                | "char"
                | "varchar"
                | "tinytext"
                | "text"
                | "mediumtext"
                | "longtext"
                | "enum"
                | "set"
        )
    }
    fn valid_locator(&self, value: &Value, require_lossless: bool) -> bool {
        if (require_lossless && !self.can_locate()) || !(value.is_string() || value.is_number()) {
            return false;
        }
        let text = value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string());
        match self.data_type.as_str() {
            "tinyint" | "smallint" | "mediumint" | "int" | "bigint" => {
                if self.unsigned {
                    text.parse::<u64>().is_ok()
                } else {
                    text.parse::<i64>().is_ok()
                }
            }
            "decimal" | "numeric" | "float" | "double" => {
                text.parse::<f64>().is_ok_and(f64::is_finite)
            }
            _ => value.is_string(),
        }
    }
}

#[derive(Debug)]
pub struct Projection {
    pub sql: String,
    pub columns: Vec<String>,
    deferred: Vec<(usize, String, &'static str)>,
}

impl Projection {
    pub fn new(
        columns: &[MysqlColumn],
        primary: &[String],
        reliable: bool,
        selected: Option<&[String]>,
    ) -> Self {
        let selected = selected.filter(|c| !c.is_empty());
        let names: Vec<String> = selected.map(Vec::from).unwrap_or_else(|| {
            columns
                .iter()
                .filter(|c| !c.invisible)
                .map(|c| c.name.clone())
                .collect()
        });
        let fallback = selected
            .map(|c| c.iter().map(|c| esc_id(c)).collect::<Vec<_>>().join(", "))
            .unwrap_or_else(|| "*".into());
        let mut result = Self {
            sql: fallback,
            columns: names,
            deferred: vec![],
        };
        if !reliable
            || primary.is_empty()
            || !primary.iter().all(|key| {
                result.columns.contains(key)
                    && columns.iter().any(|c| c.name == *key && c.can_locate())
            })
        {
            return result;
        }
        let mut parts = Vec::new();
        let mut length_parts = Vec::new();
        let mut used: HashSet<String> = columns
            .iter()
            .map(|c| c.name.to_ascii_lowercase())
            .collect();
        for (index, name) in result.columns.iter().enumerate() {
            let quoted = esc_id(name);
            let kind = columns
                .iter()
                .find(|c| c.name == *name)
                .and_then(MysqlColumn::deferred_kind)
                .filter(|_| !primary.contains(name));
            if let Some(kind) = kind {
                let mut alias = format!("__deferred_length_{index}");
                while !used.insert(alias.to_ascii_lowercase()) {
                    alias.push('_');
                }
                // JSON 的二进制内部存储需要显式转 UTF-8 字符串，LEFT 才按字符截取。
                let value = if columns
                    .iter()
                    .any(|c| c.name == *name && c.data_type == "json")
                {
                    format!("CAST({quoted} AS CHAR CHARACTER SET utf8mb4)")
                } else {
                    quoted.clone()
                };
                parts.push(format!("CASE WHEN OCTET_LENGTH({quoted}) > 4096 THEN LEFT({value}, 120) ELSE {value} END AS {quoted}"));
                length_parts.push(format!("OCTET_LENGTH({quoted}) AS {}", esc_id(&alias)));
                result.deferred.push((index, alias, kind));
            } else {
                parts.push(quoted);
            }
        }
        if !result.deferred.is_empty() {
            parts.extend(length_parts);
            result.sql = parts.join(", ");
        }
        result
    }
    pub fn finish(&self, columns: &mut Vec<String>, rows: &mut [Vec<Value>]) {
        if self.deferred.is_empty() {
            return;
        }
        for (index, alias, kind) in &self.deferred {
            let Some(length_index) = columns.iter().position(|c| c == alias) else {
                continue;
            };
            for row in rows.iter_mut() {
                let length = row.get(length_index).and_then(|v| {
                    v.as_u64()
                        .or_else(|| v.as_str().and_then(|v| v.parse().ok()))
                });
                if let (Some(length), Some(value)) = (length, row.get_mut(*index)) {
                    if length > 4096 && !value.is_null() {
                        let preview = value
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| value.to_string());
                        *value = serde_json::json!({"__deferred_field":true,"preview":preview,"byte_length":length,"kind":kind});
                    }
                }
            }
        }
        // 辅助列始终追加在投影末尾；只在确认执行了投影时移除。
        columns.truncate(self.columns.len());
        for row in rows {
            row.truncate(self.columns.len());
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn full_rows_query(
    database: &str,
    table: &str,
    columns: &[MysqlColumn],
    primary: &[String],
    reliable: bool,
    locators: &[HashMap<String, Value>],
    selected: Option<&[String]>,
) -> Result<(String, Vec<Value>), String> {
    if !reliable || primary.is_empty() {
        return Err("表缺少可靠的完整主键，无法读取完整字段".into());
    }
    if locators.is_empty() {
        return Err("没有提供主键值".into());
    }
    let require_lossless = selected.is_some();
    let selected = selected.filter(|c| !c.is_empty());
    let projection = if let Some(selected) = selected {
        let mut names = Vec::new();
        for name in selected.iter().chain(primary) {
            if !columns.iter().any(|c| c.name == *name) {
                return Err(format!("未知列: {name}"));
            }
            if !names.contains(name) {
                names.push(name.clone());
            }
        }
        names
            .iter()
            .map(|name| esc_id(name))
            .collect::<Vec<_>>()
            .join(", ")
    } else {
        // SELECT * 保持隐藏普通列；只补回已经作为定位依据的 INVISIBLE 主键。
        let invisible_keys = primary
            .iter()
            .filter(|key| {
                columns
                    .iter()
                    .any(|column| column.name == **key && column.invisible)
            })
            .map(|key| esc_id(key))
            .collect::<Vec<_>>();
        if invisible_keys.is_empty() {
            "*".into()
        } else {
            format!("{}.*, {}", esc_id(table), invisible_keys.join(", "))
        }
    };
    let mut predicates = Vec::with_capacity(locators.len());
    let mut params = Vec::new();
    for locator in locators {
        if locator.len() != primary.len() {
            return Err("必须提供每一列完整主键，且不能包含其他列".into());
        }
        let mut parts = Vec::new();
        for key in primary {
            let value = locator.get(key).ok_or("缺少主键列")?;
            let column = columns
                .iter()
                .find(|c| c.name == *key)
                .ok_or("缺少主键元数据")?;
            if !column.valid_locator(value, require_lossless) {
                return Err(format!("无效主键值: {key}"));
            }
            parts.push(format!("{} = ?", esc_id(key)));
            params.push(value.clone());
        }
        predicates.push(format!("({})", parts.join(" AND ")));
    }
    Ok((
        format!(
            "SELECT {projection} FROM {}.{} WHERE {}",
            esc_id(database),
            esc_id(table),
            predicates.join(" OR ")
        ),
        params,
    ))
}

pub fn order_by(fields: &[(String, String)], table: &str) -> String {
    let parts: Vec<String> = fields
        .iter()
        .filter(|(col, _)| !col.trim().is_empty())
        .map(|(col, order)| {
            format!(
                "{}.{} {}",
                esc_id(table),
                esc_id(col.trim()),
                if order.eq_ignore_ascii_case("DESC") {
                    "DESC"
                } else {
                    "ASC"
                }
            )
        })
        .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", parts.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn cols() -> Vec<MysqlColumn> {
        [
            ("id", "bigint", false),
            ("body", "longtext", false),
            ("payload", "json", false),
            ("blob", "blob", false),
            ("secret", "text", true),
        ]
        .into_iter()
        .map(|(name, data_type, invisible)| MysqlColumn {
            name: name.into(),
            data_type: data_type.into(),
            unsigned: true,
            invisible,
        })
        .collect()
    }
    #[test]
    fn database_projection_caps_payload_without_exposing_invisible_columns() {
        let p = Projection::new(&cols(), &["id".into()], true, None);
        assert_eq!(p.columns, vec!["id", "body", "payload", "blob"]);
        assert!(p.sql.contains("OCTET_LENGTH(`body`) > 4096"));
        assert!(p.sql.contains("LEFT(`body`, 120)"));
        assert!(!p.sql.contains("secret"));
        assert!(!p.sql.contains("LEFT(`id`"));
        assert_eq!(p.deferred.len(), 3);
    }
    #[test]
    fn missing_or_hidden_primary_key_disables_preview() {
        for (pk, reliable) in [
            (vec![], true),
            (vec!["id".into()], false),
            (vec!["secret".into()], true),
        ] {
            let p = Projection::new(&cols(), &pk, reliable, None);
            assert_eq!(p.sql, "*");
            assert!(p.deferred.is_empty());
        }
    }
    #[test]
    fn marker_preserves_unicode_null_short_json_and_large_integer_key() {
        let p = Projection::new(&cols(), &["id".into()], true, None);
        let mut columns = p.columns.clone();
        columns.extend(p.deferred.iter().map(|(_, alias, _)| alias.clone()));
        let mut rows = vec![vec![
            json!("18446744073709551615"),
            json!("😀汉字"),
            json!("{\"a\":1}"),
            Value::Null,
            json!(9000),
            json!(7),
            Value::Null,
        ]];
        p.finish(&mut columns, &mut rows);
        assert_eq!(columns, vec!["id", "body", "payload", "blob"]);
        assert_eq!(
            rows[0],
            vec![
                json!("18446744073709551615"),
                json!({"__deferred_field":true,"preview":"😀汉字","byte_length":9000,"kind":"text"}),
                json!("{\"a\":1}"),
                Value::Null
            ]
        );
    }
    #[test]
    fn composite_locators_use_one_parameterized_query_and_keep_keys() {
        let mut c = cols();
        c.push(MysqlColumn {
            name: "tenant".into(),
            data_type: "varchar".into(),
            unsigned: false,
            invisible: false,
        });
        let locators = vec![
            HashMap::from([
                ("tenant".into(), json!("x' OR 1=1")),
                ("id".into(), json!("18446744073709551615")),
            ]),
            HashMap::from([("tenant".into(), json!("y")), ("id".into(), json!(2))]),
        ];
        let (sql, params) = full_rows_query(
            "db",
            "items",
            &c,
            &["tenant".into(), "id".into()],
            true,
            &locators,
            Some(&["body".into()]),
        )
        .unwrap();
        assert_eq!(sql, "SELECT `body`, `tenant`, `id` FROM `db`.`items` WHERE (`tenant` = ? AND `id` = ?) OR (`tenant` = ? AND `id` = ?)");
        assert_eq!(
            params,
            vec![
                json!("x' OR 1=1"),
                json!("18446744073709551615"),
                json!("y"),
                json!(2)
            ]
        );
    }
    #[test]
    fn invalid_locators_and_unknown_columns_are_rejected() {
        let pk = vec!["id".into()];
        for rows in [
            vec![],
            vec![HashMap::new()],
            vec![HashMap::from([("other".into(), json!(1))])],
            vec![HashMap::from([("id".into(), Value::Null)])],
            vec![HashMap::from([(
                "id".into(),
                json!({"__deferred_field":true}),
            )])],
            vec![HashMap::from([("id".into(), json!("1x"))])],
        ] {
            assert!(full_rows_query("db", "items", &cols(), &pk, true, &rows, None).is_err());
        }
        let valid = vec![HashMap::from([("id".into(), json!(1))])];
        assert!(full_rows_query(
            "db",
            "items",
            &cols(),
            &pk,
            true,
            &valid,
            Some(&["bad".into()])
        )
        .is_err());
        assert!(full_rows_query("db", "items", &cols(), &pk, false, &valid, None).is_err());
    }
    #[test]
    fn sort_uses_original_table_column_instead_of_preview_alias() {
        assert_eq!(
            order_by(&[("body".into(), "DESC".into())], "items"),
            " ORDER BY `items`.`body` DESC"
        );
    }
    #[test]
    fn length_alias_does_not_collide_with_user_column() {
        let mut c = cols();
        c.push(MysqlColumn {
            name: "__deferred_length_1".into(),
            data_type: "text".into(),
            unsigned: false,
            invisible: false,
        });
        let p = Projection::new(&c, &["id".into()], true, None);
        assert!(p
            .deferred
            .iter()
            .all(|(_, alias, _)| !c.iter().any(|c| c.name == *alias)));
    }

    #[tokio::test]
    #[ignore = "需要 DB_CONNECT_TEST_MYSQL_URL 指向隔离测试数据库"]
    async fn mysql_deferred_live_bounds_wire_payload_and_reloads_composite_rows() {
        use crate::commands::data::mysql_value_to_json_typed;
        use mysql_async::prelude::*;
        let url = std::env::var("DB_CONNECT_TEST_MYSQL_URL").expect("isolated MySQL URL");
        let pool = mysql_async::Pool::new(mysql_async::Opts::from_url(&url).unwrap());
        let mut conn = pool.get_conn().await.unwrap();
        conn.query_drop("CREATE TEMPORARY TABLE deferred_items (tenant VARCHAR(20), id BIGINT UNSIGNED, body LONGTEXT CHARACTER SET utf8mb4, payload JSON, `blob` LONGBLOB, PRIMARY KEY(tenant,id))").await.unwrap();
        conn.exec_drop("INSERT INTO deferred_items VALUES ('a',18446744073709551615,?,?,?),('b',2,NULL,'{}',NULL)", (format!("{}z", "😀".repeat(2000)),json!({"text":"汉".repeat(3000)}).to_string(),vec![255_u8; 9000])).await.unwrap();
        let mut c = cols();
        c.retain(|col| !col.invisible);
        c.insert(
            0,
            MysqlColumn {
                name: "tenant".into(),
                data_type: "varchar".into(),
                unsigned: false,
                invisible: false,
            },
        );
        let p = Projection::new(&c, &["tenant".into(), "id".into()], true, None);
        let rows: Vec<mysql_async::Row> = conn
            .query(format!(
                "SELECT {} FROM deferred_items ORDER BY tenant",
                p.sql
            ))
            .await
            .unwrap();
        let transferred_bytes: usize = rows
            .iter()
            .flat_map(|row| (0..row.len()).filter_map(|i| row.as_ref(i)))
            .map(|v| {
                if let mysql_async::Value::Bytes(b) = v {
                    b.len()
                } else {
                    0
                }
            })
            .sum();
        assert!(
            transferred_bytes < 1600,
            "SQL must limit wire payload, got {transferred_bytes}"
        );
        let mut names = rows[0]
            .columns_ref()
            .iter()
            .map(|c| c.name_str().to_string())
            .collect();
        let mut values: Vec<Vec<Value>> = rows
            .iter()
            .map(|r| {
                r.columns_ref()
                    .iter()
                    .enumerate()
                    .map(|(i, c)| {
                        mysql_value_to_json_typed(r.as_ref(i).unwrap(), Some(c.column_type()))
                    })
                    .collect()
            })
            .collect();
        p.finish(&mut names, &mut values);
        assert_eq!(
            values[0][2]["preview"].as_str().unwrap().chars().count(),
            120
        );
        assert_eq!(values[0][2]["byte_length"], 8001);
        assert_eq!(values[0][3]["kind"], "text");
        assert_eq!(values[0][4]["kind"], "binary");
        assert_eq!(values[1][2], Value::Null);
        assert_eq!(values[1][3], "{}");
        let database: String = conn
            .query_first("SELECT DATABASE()")
            .await
            .unwrap()
            .unwrap();
        let (sql, params) = full_rows_query(
            &database,
            "deferred_items",
            &c,
            &["tenant".into(), "id".into()],
            true,
            &[HashMap::from([
                ("tenant".into(), json!("a")),
                ("id".into(), json!("18446744073709551615")),
            ])],
            Some(&["body".into()]),
        )
        .unwrap();
        let params = params
            .iter()
            .map(crate::commands::data::json_to_mysql_value)
            .collect::<Vec<_>>();
        let full: Vec<mysql_async::Row> = conn
            .exec(sql, mysql_async::Params::Positional(params))
            .await
            .unwrap();
        assert_eq!(full.len(), 1);
        assert_eq!(full[0].get::<String, _>("body").unwrap().len(), 8001);
        drop(conn);
        pool.disconnect().await.unwrap();
    }

    #[test]
    fn lossy_numeric_or_binary_primary_keys_disable_lazy_loading() {
        for kind in [
            "decimal",
            "float",
            "double",
            "varbinary",
            "bit",
            "datetime",
            "timestamp",
            "time",
        ] {
            let mut c = cols();
            c[0].data_type = kind.into();
            assert_eq!(Projection::new(&c, &["id".into()], true, None).sql, "*");
        }
    }

    #[test]
    fn full_rows_preserves_date_and_decimal_primary_values_without_enabling_lazy_load() {
        for (kind, value) in [
            ("date", json!("2026-09-23")),
            ("decimal", json!("12345678901234567890.123456")),
        ] {
            let mut columns = cols();
            columns[0].data_type = kind.into();
            let locators = [HashMap::from([("id".into(), value.clone())])];
            let (sql, params) = full_rows_query(
                "db",
                "records",
                &columns,
                &["id".into()],
                true,
                &locators,
                None,
            )
            .unwrap();
            assert_eq!(sql, "SELECT * FROM `db`.`records` WHERE (`id` = ?)");
            assert_eq!(params, vec![value]);
            assert!(full_rows_query(
                "db",
                "records",
                &columns,
                &["id".into()],
                true,
                &locators,
                Some(&["body".into()])
            )
            .is_err());
            assert_eq!(
                Projection::new(&columns, &["id".into()], true, None).sql,
                "*"
            );
        }
    }
    #[test]
    fn full_rows_appends_only_invisible_primary_keys_for_reliable_matching() {
        let mut columns = cols();
        columns[0].invisible = true;
        let (sql, _) = full_rows_query(
            "db",
            "records",
            &columns,
            &["id".into()],
            true,
            &[HashMap::from([("id".into(), json!(1))])],
            None,
        )
        .unwrap();
        assert_eq!(
            sql,
            "SELECT `records`.*, `id` FROM `db`.`records` WHERE (`id` = ?)"
        );
        assert!(!sql.contains("secret"));
    }
}
