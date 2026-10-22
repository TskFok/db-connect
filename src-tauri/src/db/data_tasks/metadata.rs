use crate::models::data_tasks::*;
use crate::models::types::DatabaseType;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DataColumn {
    pub name: String,
    pub declared_type: String,
    pub nullable: bool,
    pub default_sql: Option<String>,
    pub generated: bool,
    pub primary_key_ordinal: u32,
    pub collation: Option<String>,
    pub identity: bool,
    pub generator_safe: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DataForeignKey {
    pub from_columns: Vec<String>,
    pub parent_table: String,
    pub parent_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DataTable {
    pub name: String,
    pub create_sql: String,
    pub columns: Vec<DataColumn>,
    pub foreign_keys: Vec<DataForeignKey>,
    pub enabled_user_triggers: bool,
    pub physical: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DataMetadataSnapshot {
    pub database_type: DatabaseType,
    pub tables: Vec<DataTable>,
    pub read_only: bool,
    pub permissions_verified: bool,
    pub consistent_snapshot: bool,
    pub protected_write: bool,
    pub schema_fingerprint: String,
    pub configuration_fingerprint: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ValidatedTableMapping {
    pub source_table: String,
    pub target_table: String,
    pub source_columns: Vec<String>,
    pub target_columns: Vec<String>,
    pub key_indices: Vec<usize>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ValidatedMapping {
    pub tables: Vec<ValidatedTableMapping>,
    pub insert_order: Vec<String>,
    pub delete_order: Vec<String>,
}

pub const CLICKHOUSE_TARGET_BLOCKER:&str="ClickHouse 目标追加暂未开放：无法原子绑定已预览的物理表和写入依赖，可能写入重建表或触发新物化视图";
fn transaction_database(database: DatabaseType) -> bool {
    matches!(
        database,
        DatabaseType::Sqlite
            | DatabaseType::Postgres
            | DatabaseType::MySql
            | DatabaseType::SqlServer
    )
}
fn capabilities(
    source: DatabaseType,
    target: DatabaseType,
    read_only: bool,
    safe: bool,
) -> DataTaskCapabilities {
    let supported = transaction_database(target) && safe && !read_only;
    let row_sync = supported && source == target;
    let modes = if !supported {
        vec![]
    } else if source == DatabaseType::ClickHouse {
        vec![DataTaskMode::Append]
    } else if row_sync {
        vec![
            DataTaskMode::Merge,
            DataTaskMode::Mirror,
            DataTaskMode::Append,
            DataTaskMode::Replace,
        ]
    } else {
        vec![DataTaskMode::Append, DataTaskMode::Replace]
    };
    DataTaskCapabilities {
        source_tables: vec![],
        target_tables: vec![],
        row_sync,
        transfer: supported,
        supported_modes: modes,
        blockers: if supported {
            vec![]
        } else {
            vec![DataTaskBlocker {
                code: if read_only {
                    "read_only_target"
                } else {
                    "unsupported_capability"
                }
                .into(),
                message: if target == DatabaseType::ClickHouse {
                    CLICKHOUSE_TARGET_BLOCKER
                } else if read_only {
                    "目标连接或实例只读"
                } else {
                    "无法验证数据库完整读取权限、目标一致快照或受保护写入"
                }
                .into(),
                table: None,
            }]
        },
    }
}
/// 四类事务库及 ClickHouse 源的能力均经过独立原生会话验收；目标 ClickHouse 保持关闭。
pub fn get_config_capabilities(
    source: &crate::models::types::ConnectionConfig,
    target: &crate::models::types::ConnectionConfig,
) -> DataTaskCapabilities {
    capabilities(
        source.database_type,
        target.database_type,
        target.read_only.unwrap_or(false),
        true,
    )
}
pub fn get_capabilities(
    source: &DataMetadataSnapshot,
    target: &DataMetadataSnapshot,
) -> DataTaskCapabilities {
    capabilities(
        source.database_type,
        target.database_type,
        target.read_only,
        (source.consistent_snapshot || source.database_type == DatabaseType::ClickHouse)
            && target.consistent_snapshot
            && target.protected_write
            && source.permissions_verified
            && target.permissions_verified,
    )
}
pub fn validate_mapping(
    request: &DataTaskRequest,
    source: &DataMetadataSnapshot,
    target: &DataMetadataSnapshot,
) -> Result<ValidatedMapping, String> {
    request
        .validate()
        .map_err(|e| format!("{}: {}", e.code, e.message))?;
    if target.database_type == DatabaseType::ClickHouse {
        return Err(format!(
            "unsupported_capability: {CLICKHOUSE_TARGET_BLOCKER}"
        ));
    }
    if source.database_type == DatabaseType::ClickHouse
        && (request.kind != DataTaskKind::Transfer || request.mode != DataTaskMode::Append)
    {
        return Err("unsupported_capability: ClickHouse 源仅支持追加传输".into());
    }
    if target.read_only {
        return Err("read_only_target: 目标连接或实例只读".into());
    }
    if !source.permissions_verified || !target.permissions_verified {
        return Err(
            "unsupported_capability: 无法验证完整读取与写入权限，或存在行级安全策略".into(),
        );
    }
    if (!source.consistent_snapshot && source.database_type != DatabaseType::ClickHouse)
        || !target.consistent_snapshot
        || !target.protected_write
    {
        return Err("unsupported_capability: 数据库不能提供一致快照或受保护写入".into());
    }
    if source.database_type != target.database_type && request.kind == DataTaskKind::RowSync {
        return Err("unsupported_capability: 跨类型不支持行同步".into());
    }
    if !matches!(
        source.database_type,
        DatabaseType::Sqlite
            | DatabaseType::Postgres
            | DatabaseType::MySql
            | DatabaseType::SqlServer
            | DatabaseType::ClickHouse
    ) {
        return Err("unsupported_capability: 该数据库驱动尚未通过真实数据库验收".into());
    }
    let mut output = Vec::new();
    for mapping in &request.mappings {
        let s = source
            .tables
            .iter()
            .find(|t| t.name == mapping.source_table)
            .ok_or("invalid_mapping: 源表不存在")?;
        let t = target
            .tables
            .iter()
            .find(|t| t.name == mapping.target_table)
            .ok_or("invalid_mapping: 目标表不存在，请先使用数据库结构同步")?;
        if !s.physical || !t.physical {
            return Err("unsupported_capability: 仅支持普通物理表".into());
        }
        if t.enabled_user_triggers {
            return Err("unsupported_capability: 目标表存在启用的写触发器".into());
        }
        let mut source_columns = Vec::new();
        let mut target_columns = Vec::new();
        let mut ordered_columns: Vec<_> = mapping.columns.iter().collect();
        ordered_columns.sort_by(|a, b| a.target_column.cmp(&b.target_column));
        for column in ordered_columns {
            let sc = s
                .columns
                .iter()
                .find(|c| c.name == column.source_column)
                .ok_or("invalid_mapping: 源字段不存在")?;
            let tc = t
                .columns
                .iter()
                .find(|c| c.name == column.target_column)
                .ok_or("invalid_mapping: 目标字段不存在")?;
            if tc.generated {
                return Err("invalid_mapping: 生成字段不能作为写入目标".into());
            }
            if tc.identity && !tc.generator_safe {
                return Err("unsupported_capability: 无法安全保留自增键或维护生成器高水位".into());
            }
            if super::type_mapping::resolve_database_transfer_type(
                source.database_type,
                &sc.declared_type,
                target.database_type,
                &tc.declared_type,
            ) != super::type_mapping::TypeCompatibility::Compatible
            {
                return Err("unsupported_capability: 字段类型不能证明无损兼容".into());
            }
            source_columns.push(sc.name.clone());
            target_columns.push(tc.name.clone());
        }
        for column in &t.columns {
            if !column.generated
                && !column.nullable
                && column.default_sql.is_none()
                && !column.identity
                && !target_columns.contains(&column.name)
            {
                return Err("invalid_mapping: 目标非空无默认值字段缺少映射".into());
            }
        }
        let mut key_indices = Vec::new();
        if request.kind == DataTaskKind::RowSync {
            let mut sk: Vec<_> = s
                .columns
                .iter()
                .filter(|c| c.primary_key_ordinal > 0)
                .collect();
            sk.sort_by_key(|c| c.primary_key_ordinal);
            let mut tk: Vec<_> = t
                .columns
                .iter()
                .filter(|c| c.primary_key_ordinal > 0)
                .collect();
            tk.sort_by_key(|c| c.primary_key_ordinal);
            if sk.is_empty() || sk.len() != tk.len() {
                return Err("invalid_mapping: 同步要求双方拥有完整真实主键".into());
            }
            for (sc, tc) in sk.iter().zip(tk.iter()) {
                if key_is_float(&sc.declared_type) || key_is_float(&tc.declared_type) {
                    return Err("unsupported_capability: 浮点主键的零和特殊值不能证明与数据库唯一性语义一致".into());
                }
                if sc.nullable || tc.nullable {
                    return Err("invalid_mapping: 同步定位键不能为空".into());
                }
                let index = source_columns
                    .iter()
                    .zip(&target_columns)
                    .position(|(source, target)| source == &sc.name && target == &tc.name)
                    .ok_or("invalid_mapping: 主键映射不完整或顺序不一致")?;
                if (key_is_text(&sc.declared_type) || key_is_text(&tc.declared_type))
                    && (sc.collation.as_deref() != Some("BINARY")
                        || tc.collation.as_deref() != Some("BINARY"))
                {
                    return Err("unsupported_capability: 无法证明字符串主键排序规则一致".into());
                }
                key_indices.push(index);
            }
        }
        output.push(ValidatedTableMapping {
            source_table: s.name.clone(),
            target_table: t.name.clone(),
            source_columns,
            target_columns,
            key_indices,
        });
    }
    // 依赖检查只访问内存中的一次批量元数据，不执行 SQL。
    let selected: std::collections::BTreeSet<_> =
        output.iter().map(|t| t.target_table.clone()).collect();
    let mut dependencies =
        std::collections::BTreeMap::<String, std::collections::BTreeSet<String>>::new();
    for name in &selected {
        dependencies.insert(name.clone(), std::collections::BTreeSet::new());
    }
    for table in &target.tables {
        for fk in &table.foreign_keys {
            if selected.contains(&table.name) || selected.contains(&fk.parent_table) {
                if !selected.contains(&table.name) || !selected.contains(&fk.parent_table) {
                    return Err("unsupported_capability: 目标范围存在外部表外键依赖".into());
                }
                if !matches!(
                    fk.on_update.to_ascii_uppercase().as_str(),
                    "NO ACTION" | "RESTRICT"
                ) || !matches!(
                    fk.on_delete.to_ascii_uppercase().as_str(),
                    "NO ACTION" | "RESTRICT"
                ) {
                    return Err("unsupported_capability: 不支持可能级联写入的外键".into());
                }
                dependencies
                    .get_mut(&table.name)
                    .unwrap()
                    .insert(fk.parent_table.clone());
            }
        }
    }
    let mut insert_order = Vec::new();
    while !dependencies.is_empty() {
        let ready: Vec<_> = dependencies
            .iter()
            .filter(|(_, v)| v.is_empty())
            .map(|(k, _)| k.clone())
            .collect();
        if ready.is_empty() {
            return Err("unsupported_capability: 目标外键存在循环依赖".into());
        }
        for name in ready {
            dependencies.remove(&name);
            for dep in dependencies.values_mut() {
                dep.remove(&name);
            }
            insert_order.push(name);
        }
    }
    output.sort_by(|a, b| a.target_table.cmp(&b.target_table));
    let delete_order = insert_order.iter().rev().cloned().collect();
    Ok(ValidatedMapping {
        tables: output,
        insert_order,
        delete_order,
    })
}
fn key_is_float(t: &str) -> bool {
    let t = t.trim().to_ascii_uppercase();
    matches!(
        t.split('(').next().unwrap_or(""),
        "FLOAT" | "REAL" | "DOUBLE" | "DOUBLE PRECISION" | "FLOAT4" | "FLOAT8"
    )
}
fn key_is_text(t: &str) -> bool {
    let t = t.to_ascii_uppercase();
    t.contains("CHAR") || t.contains("TEXT") || t.contains("CLOB")
}

#[derive(Clone, Debug)]
pub struct EndpointIdentity {
    pub database_type: DatabaseType,
    pub instance: Option<String>,
    pub database: String,
    pub sqlite_path: Option<std::path::PathBuf>,
}
pub fn resolve_endpoints(
    request: &DataTaskRequest,
    source: EndpointIdentity,
    target: EndpointIdentity,
) -> Result<(), String> {
    if source.database_type == DatabaseType::Sqlite && target.database_type == DatabaseType::Sqlite
    {
        let a = source
            .sqlite_path
            .as_ref()
            .ok_or("same_physical_target: 无法确认源文件身份")?;
        let b = target
            .sqlite_path
            .as_ref()
            .ok_or("same_physical_target: 无法确认目标文件身份")?;
        let ac =
            std::fs::canonicalize(a).map_err(|_| "same_physical_target: 无法确认源文件身份")?;
        let bc =
            std::fs::canonicalize(b).map_err(|_| "same_physical_target: 无法确认目标文件身份")?;
        // 同时持有两个文件句柄，Unix 比较 dev/ino，Windows 比较卷和文件 ID。
        // canonical path 不能识别硬链接；无法读取身份时不放行。
        let same = ac == bc
            || same_file::is_same_file(&ac, &bc)
                .map_err(|_| "same_physical_target: 无法验证 SQLite 物理文件身份")?;
        if same {
            return Err("same_physical_target: 源和目标指向同一个 SQLite 文件".into());
        }
    } else if source.database_type == target.database_type {
        let same_instance = match (&source.instance, &target.instance) {
            (Some(a), Some(b)) => a == b,
            _ => return Err("same_physical_target: 无法验证源目标服务实例身份".into()),
        };
        if same_instance
            && source.database.eq_ignore_ascii_case(&target.database)
            && request.mappings.iter().any(|m| {
                request
                    .mappings
                    .iter()
                    .any(|n| m.source_table.eq_ignore_ascii_case(&n.target_table))
            })
        {
            return Err("same_physical_target: 源和目标包含同一物理表".into());
        }
    }
    Ok(())
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub fn request(mode: DataTaskMode) -> DataTaskRequest {
        DataTaskRequest {
            protocol_version: 1,
            kind: if matches!(mode, DataTaskMode::Merge | DataTaskMode::Mirror) {
                DataTaskKind::RowSync
            } else {
                DataTaskKind::Transfer
            },
            source: DataEndpoint {
                saved_connection_id: "s".into(),
                database: "main".into(),
            },
            target: DataEndpoint {
                saved_connection_id: "t".into(),
                database: "main".into(),
            },
            mappings: vec![TableMapping {
                source_table: "t".into(),
                target_table: "t".into(),
                columns: vec![
                    ColumnMapping {
                        source_column: "id".into(),
                        target_column: "id".into(),
                    },
                    ColumnMapping {
                        source_column: "v".into(),
                        target_column: "v".into(),
                    },
                ],
            }],
            mode,
        }
    }
    pub fn metadata() -> DataMetadataSnapshot {
        DataMetadataSnapshot {
            database_type: DatabaseType::Sqlite,
            tables: vec![DataTable {
                name: "t".into(),
                create_sql: "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)".into(),
                columns: vec![
                    DataColumn {
                        name: "id".into(),
                        declared_type: "INTEGER".into(),
                        nullable: false,
                        default_sql: None,
                        generated: false,
                        primary_key_ordinal: 1,
                        collation: Some("BINARY".into()),
                        identity: true,
                        generator_safe: true,
                    },
                    DataColumn {
                        name: "v".into(),
                        declared_type: "TEXT".into(),
                        nullable: true,
                        default_sql: None,
                        generated: false,
                        primary_key_ordinal: 0,
                        collation: Some("BINARY".into()),
                        identity: false,
                        generator_safe: false,
                    },
                ],
                foreign_keys: vec![],
                enabled_user_triggers: false,
                physical: true,
            }],
            read_only: false,
            permissions_verified: true,
            consistent_snapshot: true,
            protected_write: true,
            schema_fingerprint: "schema".into(),
            configuration_fingerprint: "fixture".into(),
        }
    }
    #[test]
    fn valid_mapping_preserves_key_projection() {
        let m = metadata();
        let v = validate_mapping(&request(DataTaskMode::Merge), &m, &m).unwrap();
        assert_eq!(v.tables[0].key_indices, vec![0]);
    }
    #[test]
    fn unsafe_targets_are_rejected() {
        let s = metadata();
        for n in 0..7 {
            let mut t = metadata();
            match n {
                0 => t.read_only = true,
                1 => t.permissions_verified = false,
                2 => t.protected_write = false,
                3 => t.tables[0].enabled_user_triggers = true,
                4 => t.tables[0].physical = false,
                5 => t.tables[0].columns[0].generator_safe = false,
                _ => t.tables[0].columns[0].primary_key_ordinal = 0,
            };
            assert!(
                validate_mapping(&request(DataTaskMode::Merge), &s, &t).is_err(),
                "case {n}"
            );
        }
    }
    #[test]
    fn required_columns_and_unknown_collation_block() {
        let s = metadata();
        let mut t = metadata();
        t.tables[0].columns.push(DataColumn {
            name: "required".into(),
            declared_type: "TEXT".into(),
            nullable: false,
            default_sql: None,
            generated: false,
            primary_key_ordinal: 0,
            collation: None,
            identity: false,
            generator_safe: false,
        });
        assert!(validate_mapping(&request(DataTaskMode::Append), &s, &t).is_err());
        let mut t = metadata();
        t.tables[0].columns[0].declared_type = "TEXT".into();
        t.tables[0].columns[0].collation = Some("NOCASE".into());
        assert!(validate_mapping(&request(DataTaskMode::Merge), &s, &t).is_err());
    }
    #[test]
    fn cascade_and_external_dependencies_block() {
        let s = metadata();
        let mut t = metadata();
        t.tables[0].foreign_keys.push(DataForeignKey {
            from_columns: vec!["id".into()],
            parent_table: "outside".into(),
            parent_columns: vec!["id".into()],
            on_update: "NO ACTION".into(),
            on_delete: "CASCADE".into(),
        });
        assert!(validate_mapping(&request(DataTaskMode::Append), &s, &t).is_err());
    }
}
#[cfg(test)]
mod boundary_tests {
    use super::tests::{metadata, request};
    use super::*;
    #[test]
    fn same_sqlite_inode_and_symlink_are_rejected_independent_of_saved_id() {
        let dir =
            std::env::temp_dir().join(format!("db-connect-identity-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let a = dir.join("a.sqlite");
        let b = dir.join("b.sqlite");
        std::fs::write(&a, []).unwrap();
        std::fs::hard_link(&a, &b).unwrap();
        let identity = |p| EndpointIdentity {
            database_type: DatabaseType::Sqlite,
            instance: None,
            database: "main".into(),
            sqlite_path: Some(p),
        };
        assert!(resolve_endpoints(
            &request(DataTaskMode::Append),
            identity(a.clone()),
            identity(b.clone())
        )
        .unwrap_err()
        .contains("same_physical_target"));
        std::fs::remove_file(&b).unwrap();
        std::fs::write(&b, []).unwrap();
        assert!(
            resolve_endpoints(&request(DataTaskMode::Append), identity(a), identity(b)).is_ok()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn physical_network_identity_uses_database_and_full_object_overlap() {
        let id = |db: &str| EndpointIdentity {
            database_type: DatabaseType::Postgres,
            instance: Some("server-instance".into()),
            database: db.into(),
            sqlite_path: None,
        };
        let mut r = request(DataTaskMode::Mirror);
        r.target.saved_connection_id = r.source.saved_connection_id.clone();
        assert!(resolve_endpoints(&r, id("one"), id("two")).is_ok());
        r.target.saved_connection_id = "different-saved-alias".into();
        assert!(resolve_endpoints(&r, id("same"), id("same")).is_err());
        let mut unknown = id("other");
        unknown.instance = None;
        assert!(resolve_endpoints(&r, id("same"), unknown).is_err());
    }
    #[test]
    fn mapping_order_is_canonical_and_generated_fields_block_writes() {
        let m = metadata();
        let mut r = request(DataTaskMode::Merge);
        r.mappings[0].columns.reverse();
        let a = validate_mapping(&r, &m, &m).unwrap();
        assert_eq!(a.tables[0].target_columns, vec!["id", "v"]);
        assert_eq!(a.tables[0].key_indices, vec![0]);
        let mut t = metadata();
        t.tables[0].columns[1].generated = true;
        assert!(validate_mapping(&r, &m, &t).is_err());
    }
    #[test]
    fn append_allows_no_primary_key_but_sync_does_not() {
        let mut m = metadata();
        m.tables[0].columns[0].primary_key_ordinal = 0;
        m.tables[0].columns[0].identity = false;
        assert!(validate_mapping(&request(DataTaskMode::Append), &m, &m).is_ok());
        assert!(validate_mapping(&request(DataTaskMode::Merge), &m, &m).is_err());
    }
    #[test]
    fn foreign_keys_sort_parents_first_and_cycles_are_blocked() {
        let mut m = metadata();
        let mut child = m.tables[0].clone();
        child.name = "child".into();
        child.foreign_keys.push(DataForeignKey {
            from_columns: vec!["id".into()],
            parent_table: "t".into(),
            parent_columns: vec!["id".into()],
            on_update: "NO ACTION".into(),
            on_delete: "RESTRICT".into(),
        });
        m.tables.push(child);
        let mut r = request(DataTaskMode::Append);
        let mut child = r.mappings[0].clone();
        child.source_table = "child".into();
        child.target_table = "child".into();
        r.mappings.push(child);
        let map = validate_mapping(&r, &m, &m).unwrap();
        assert_eq!(map.insert_order, vec!["t", "child"]);
        assert_eq!(map.delete_order, vec!["child", "t"]);
        m.tables[0].foreign_keys.push(DataForeignKey {
            from_columns: vec!["id".into()],
            parent_table: "child".into(),
            parent_columns: vec!["id".into()],
            on_update: "NO ACTION".into(),
            on_delete: "NO ACTION".into(),
        });
        assert!(validate_mapping(&r, &m, &m).is_err());
    }
    #[test]
    fn unaccepted_database_combinations_remain_disabled() {
        let s = metadata();
        for t in [
            DatabaseType::MySql,
            DatabaseType::Postgres,
            DatabaseType::SqlServer,
            DatabaseType::ClickHouse,
        ] {
            let mut target = s.clone();
            target.database_type = t;
            let capabilities = get_capabilities(&s, &target);
            assert!(
                !capabilities.row_sync
                    && (if t == DatabaseType::ClickHouse {
                        !capabilities.transfer && capabilities.supported_modes.is_empty()
                    } else {
                        capabilities.transfer
                            && capabilities.supported_modes
                                == vec![DataTaskMode::Append, DataTaskMode::Replace]
                    })
            );
            assert!(validate_mapping(&request(DataTaskMode::Append), &s, &target).is_err());
        }
    }
    #[test]
    fn clickhouse_target_stays_closed_even_when_snapshot_flags_claim_safety() {
        let source = metadata();
        let mut target = metadata();
        target.database_type = DatabaseType::ClickHouse;
        target.consistent_snapshot = true;
        target.protected_write = true;
        target.permissions_verified = true;
        let capabilities = get_capabilities(&source, &target);
        assert!(!capabilities.transfer && !capabilities.row_sync);
        assert!(capabilities.supported_modes.is_empty());
        assert_eq!(capabilities.blockers[0].message, CLICKHOUSE_TARGET_BLOCKER);
        for mode in [
            DataTaskMode::Append,
            DataTaskMode::Replace,
            DataTaskMode::Merge,
            DataTaskMode::Mirror,
        ] {
            assert!(validate_mapping(&request(mode), &source, &target)
                .unwrap_err()
                .contains(CLICKHOUSE_TARGET_BLOCKER));
        }
    }
    #[test]
    fn clickhouse_only_allows_append_from_source_into_transactional_targets() {
        let mut source = metadata();
        source.database_type = DatabaseType::ClickHouse;
        source.consistent_snapshot = false;
        source.protected_write = false;
        source.tables[0].columns[0].declared_type = "Int64".into();
        source.tables[0].columns[1].declared_type = "Nullable(String)".into();
        let mut target = metadata();
        target.tables[0].columns[1].declared_type = "BLOB".into();
        let capabilities = get_capabilities(&source, &target);
        assert!(capabilities.transfer && !capabilities.row_sync);
        assert_eq!(capabilities.supported_modes, vec![DataTaskMode::Append]);
        assert!(validate_mapping(&request(DataTaskMode::Append), &source, &target).is_ok());
        assert!(
            validate_mapping(&request(DataTaskMode::Replace), &source, &target)
                .unwrap_err()
                .contains("仅支持追加")
        );
        assert!(validate_mapping(&request(DataTaskMode::Merge), &source, &target).is_err());
        assert!(!get_capabilities(&target, &source).transfer);
        assert!(
            validate_mapping(&request(DataTaskMode::Append), &target, &source)
                .unwrap_err()
                .contains(CLICKHOUSE_TARGET_BLOCKER)
        );
        target.protected_write = false;
        assert!(!get_capabilities(&source, &target).transfer);
        assert!(validate_mapping(&request(DataTaskMode::Append), &source, &target).is_err());
    }
}
#[cfg(test)]
mod floating_keys {
    use super::*;
    #[test]
    fn floating_primary_keys_are_blocked_before_snapshot() {
        let mut m = tests::metadata();
        m.tables[0].columns[0].declared_type = "REAL".into();
        m.tables[0].columns[0].identity = false;
        assert!(
            validate_mapping(&tests::request(DataTaskMode::Merge), &m, &m)
                .unwrap_err()
                .contains("浮点")
        );
    }
}
