use super::*;
use crate::db::metadata_batch::{group_tables, normalize_databases};

fn table(name: &str, view: bool) -> TableInfo {
    TableInfo {
        name: name.into(),
        table_type: if view { "VIEW" } else { "TABLE" }.into(),
        engine: (!view).then(|| "InnoDB".into()),
        rows: (!view).then_some(7),
        data_length: None,
        index_length: None,
        comment: "测试注释".into(),
    }
}

#[test]
fn metadata_batch_contract_preserves_order_deduplicates_and_keeps_empty_groups() {
    let databases =
        normalize_databases(&["z".into(), "empty".into(), "z".into(), "a".into()]).unwrap();
    assert_eq!(databases, ["z", "empty", "a"]);
    let grouped = group_tables(
        &databases,
        vec![
            ("a".into(), table("same", true)),
            ("z".into(), table("same", false)),
        ],
    )
    .unwrap();
    assert_eq!(
        grouped
            .iter()
            .map(|g| g.database.as_str())
            .collect::<Vec<_>>(),
        ["z", "empty", "a"]
    );
    assert!(grouped[1].tables.is_empty());
    assert_eq!(grouped[0].tables[0].table_type, "TABLE");
    assert_eq!(grouped[2].tables[0].table_type, "VIEW");
    assert_eq!(grouped[2].tables[0].rows, None);
    assert_eq!(grouped[2].tables[0].comment, "测试注释");
}

#[tokio::test]
async fn metadata_batch_contract_empty_and_oversized_never_acquire_mysql_connection() {
    let pool = mysql_async::Pool::new("mysql://batch-test@127.0.0.1:1");
    assert!(list_mysql_tables_batch(&pool, &[])
        .await
        .unwrap()
        .is_empty());
    let oversized = (0..257).map(|i| format!("db{i}")).collect::<Vec<_>>();
    assert!(list_mysql_tables_batch(&pool, &oversized)
        .await
        .unwrap_err()
        .contains("256"));
    assert_eq!(
        normalize_databases(&vec!["same".into(); 257]).unwrap(),
        ["same"]
    );
    assert_eq!(normalize_databases(&oversized[..256]).unwrap().len(), 256);
}

#[test]
fn metadata_batch_quoted_names_are_mysql_values_and_keep_case() {
    let databases = vec![
        "O'Reilly`\"[x];--".to_string(),
        "Case".into(),
        "case".into(),
    ];
    let (sql, values) = mysql_catalog_query(&databases);
    assert!(!sql.contains("O'Reilly"));
    assert_eq!(sql.matches('?').count(), 9);
    let expected = databases
        .iter()
        .map(|d| mysql_async::Value::from(d.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(&values[..3], expected.as_slice());
    assert_eq!(&values[3..6], expected.as_slice());
    assert_eq!(&values[6..], expected.as_slice());
    assert_eq!(normalize_databases(&databases).unwrap(), databases);
}

#[test]
fn metadata_batch_preserves_types_and_permissions() {
    let databases = vec!["full".into(), "empty".into()];
    let rows = vec![
        MySqlCatalogRow {
            request_order: 0,
            visible_database: Some("full".into()),
            name: Some("items".into()),
            engine: Some("InnoDB".into()),
            rows: Some(7),
            data_length: Some(128),
            index_length: None,
            comment: Some("注释".into()),
        },
        MySqlCatalogRow {
            request_order: 0,
            visible_database: Some("full".into()),
            name: Some("visible_items".into()),
            engine: None,
            rows: None,
            data_length: None,
            index_length: None,
            comment: Some("VIEW".into()),
        },
        MySqlCatalogRow {
            request_order: 1,
            visible_database: Some("empty".into()),
            name: None,
            engine: None,
            rows: None,
            data_length: None,
            index_length: None,
            comment: None,
        },
    ];
    let grouped = map_mysql_catalog_rows(&databases, rows).unwrap();
    assert_eq!(grouped[0].tables[0].engine.as_deref(), Some("InnoDB"));
    assert_eq!(grouped[0].tables[0].rows, Some(7));
    assert_eq!(grouped[0].tables[0].data_length, Some(128));
    assert_eq!(grouped[0].tables[0].index_length, None);
    assert_eq!(grouped[0].tables[0].comment, "注释");
    assert_eq!(grouped[0].tables[1].table_type, "VIEW");
    assert_eq!(grouped[0].tables[1].rows, None);
    assert!(grouped[1].tables.is_empty());
    let error = map_mysql_catalog_rows(
        &["hidden".into()],
        vec![MySqlCatalogRow {
            request_order: 0,
            visible_database: None,
            name: None,
            engine: None,
            rows: None,
            data_length: None,
            index_length: None,
            comment: None,
        }],
    )
    .unwrap_err();
    assert!(error.contains("hidden"));
    assert!(error.contains("不存在或无权访问"));
}

#[test]
fn metadata_batch_mysql_schema_matching_respects_server_case_mode() {
    let (sql, _) = mysql_catalog_query(&["Case".into(), "case".into()]);
    assert!(sql.contains("@@lower_case_table_names = 0"));
    assert!(sql.contains("BINARY s.SCHEMA_NAME = BINARY r.database_name"));
    assert!(sql.contains("BINARY LOWER(s.SCHEMA_NAME) = BINARY LOWER(r.database_name)"));
    assert!(sql.contains("BINARY t.TABLE_SCHEMA = BINARY s.SCHEMA_NAME"));
}

#[test]
fn metadata_batch_mysql_preserves_show_binary_name_order() {
    let (sql, _) = mysql_catalog_query(&["schema".into()]);
    assert!(sql.contains("ORDER BY r.request_order, BINARY t.TABLE_NAME"));
}

#[test]
fn metadata_batch_mysql_limits_catalog_scan_to_requested_schemas() {
    let (sql, _) = mysql_catalog_query(&["one".into(), "two".into()]);
    assert!(sql.contains("WHERE SCHEMA_NAME IN (?, ?)"));
    assert!(sql.contains("WHERE TABLE_SCHEMA IN (?, ?)"));
    assert!(sql.contains("LIMIT 18446744073709551615"));
}
