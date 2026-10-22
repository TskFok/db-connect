#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeCompatibility {
    Compatible,
    Unsupported,
}
#[derive(Debug, Clone, PartialEq, Eq)]
enum DataType {
    Integer { bits: u8, unsigned: bool },
    Decimal { precision: u16, scale: u16 },
    Text(Option<u64>),
    Binary(Option<u64>),
    Boolean,
    Float(u8),
    Temporal { kind: String, precision: u8 },
    Uuid,
    Json,
}
fn parse(t: &str) -> Option<DataType> {
    let upper = t.trim().to_ascii_uppercase();
    let t = upper.split_whitespace().collect::<Vec<_>>().join(" ");
    let unsigned = t.ends_with(" UNSIGNED");
    let base = t.strip_suffix(" UNSIGNED").unwrap_or(&t);
    let bits = match base {
        "TINYINT" | "INT1" => Some(8),
        "SMALLINT" | "INT2" => Some(16),
        "MEDIUMINT" => Some(24),
        "INT" | "INTEGER" | "INT4" => Some(32),
        "BIGINT" | "INT8" => Some(64),
        _ => None,
    };
    if let Some(bits) = bits {
        return Some(DataType::Integer { bits, unsigned });
    }
    if unsigned {
        return None;
    }
    let args = |prefix: &str| -> Option<&str> {
        t.strip_prefix(prefix)?.strip_prefix('(')?.strip_suffix(')')
    };
    for prefix in ["DECIMAL", "NUMERIC"] {
        if let Some(p) = args(prefix) {
            let mut p = p.split(',').map(str::trim);
            let precision = p.next()?.parse::<u16>().ok()?;
            let scale = p.next()?.parse::<u16>().ok()?;
            if p.next().is_none() && precision > 0 && precision <= 76 && scale <= precision {
                return Some(DataType::Decimal { precision, scale });
            }
            return None;
        }
    }
    if matches!(
        t.as_str(),
        "TEXT" | "CLOB" | "LONGTEXT" | "MEDIUMTEXT" | "NVARCHAR(MAX)" | "VARCHAR(MAX)"
    ) {
        return Some(DataType::Text(None));
    }
    for prefix in ["VARCHAR", "NVARCHAR", "CHAR", "NCHAR", "CHARACTER VARYING"] {
        if let Some(n) = args(prefix) {
            let n = n.parse().ok()?;
            return Some(DataType::Text(Some(n)));
        }
    }
    if matches!(
        t.as_str(),
        "BLOB" | "LONGBLOB" | "MEDIUMBLOB" | "BYTEA" | "VARBINARY(MAX)"
    ) {
        return Some(DataType::Binary(None));
    }
    for prefix in ["VARBINARY", "BINARY"] {
        if let Some(n) = args(prefix) {
            return Some(DataType::Binary(Some(n.parse().ok()?)));
        }
    }
    match t.as_str() {
        "BOOL" | "BOOLEAN" | "BIT" => return Some(DataType::Boolean),
        "REAL" | "FLOAT" | "DOUBLE" | "DOUBLE PRECISION" => return Some(DataType::Float(64)),
        "FLOAT4" => return Some(DataType::Float(32)),
        "UUID" | "UNIQUEIDENTIFIER" => return Some(DataType::Uuid),
        "JSON" => return Some(DataType::Json),
        _ => {}
    }
    for kind in [
        "TIMESTAMP WITH TIME ZONE",
        "TIMESTAMP WITHOUT TIME ZONE",
        "DATETIMEOFFSET",
        "TIMESTAMP",
        "DATETIME2",
        "DATETIME",
        "TIME",
        "DATE",
    ] {
        if t == kind {
            return Some(DataType::Temporal {
                kind: kind.into(),
                precision: 6,
            });
        }
        if let Some(n) = args(kind) {
            let precision = n.parse().ok()?;
            if precision <= 9 {
                return Some(DataType::Temporal {
                    kind: kind.into(),
                    precision,
                });
            }
        }
    }
    None
}
pub fn resolve_transfer_type(source: &str, target: &str) -> TypeCompatibility {
    use DataType::*;
    let (Some(s), Some(t)) = (parse(source), parse(target)) else {
        return TypeCompatibility::Unsupported;
    };
    let compatible = match (s, t) {
        (
            Integer {
                bits: a,
                unsigned: au,
            },
            Integer {
                bits: b,
                unsigned: bu,
            },
        ) => {
            if au == bu {
                b >= a
            } else {
                au && !bu && b > a
            }
        }
        (
            Decimal {
                precision: a,
                scale: sa,
            },
            Decimal {
                precision: b,
                scale: sb,
            },
        ) => sb >= sa && b - sb >= a - sa,
        (Text(a), Text(b)) | (Binary(a), Binary(b)) => match (a, b) {
            (_, None) => true,
            (Some(a), Some(b)) => b >= a,
            _ => false,
        },
        (Float(a), Float(b)) => b >= a,
        (Boolean, Boolean) | (Uuid, Uuid) | (Json, Json) => true,
        (
            Temporal {
                kind: a,
                precision: pa,
            },
            Temporal {
                kind: b,
                precision: pb,
            },
        ) => a == b && pb >= pa,
        _ => false,
    };
    if compatible {
        TypeCompatibility::Compatible
    } else {
        TypeCompatibility::Unsupported
    }
}

fn database_type_name(
    database: crate::models::types::DatabaseType,
    declared: &str,
    cross: bool,
    target: bool,
) -> Option<String> {
    use crate::models::types::DatabaseType;
    let upper = declared.trim().to_ascii_uppercase();
    if database == DatabaseType::ClickHouse {
        let native = upper
            .strip_prefix("NULLABLE(")
            .and_then(|v| v.strip_suffix(')'))
            .unwrap_or(&upper);
        return match native {
            "INT8" => Some("TINYINT".into()),
            "INT16" => Some("SMALLINT".into()),
            "INT32" => Some("INTEGER".into()),
            "INT64" => Some("BIGINT".into()),
            "UINT8" => Some("TINYINT UNSIGNED".into()),
            "UINT16" => Some("SMALLINT UNSIGNED".into()),
            "UINT32" => Some("INTEGER UNSIGNED".into()),
            "UINT64" => Some("BIGINT UNSIGNED".into()),
            "STRING" => Some("LONGBLOB".into()),
            _ => None,
        };
    }
    if database == DatabaseType::Sqlite {
        if upper.contains("INT") {
            return Some("BIGINT".into());
        }
        if upper == "BOOL" || upper == "BOOLEAN" {
            return Some("BOOLEAN".into());
        }
        if cross
            && (upper.starts_with("NUMERIC")
                || upper.starts_with("DECIMAL")
                || parse(&upper).is_some_and(|t| matches!(t, DataType::Temporal { .. })))
        {
            return None;
        }
    }
    if database == DatabaseType::SqlServer && upper == "TINYINT" {
        return Some("TINYINT UNSIGNED".into());
    }
    if matches!(database, DatabaseType::Postgres | DatabaseType::SqlServer) && upper == "REAL" {
        return Some("FLOAT4".into());
    }
    if database == DatabaseType::MySql {
        if cross && target && matches!(upper.as_str(), "TEXT" | "TINYTEXT" | "BLOB" | "TINYBLOB") {
            return None;
        }
        if upper == "FLOAT" {
            return Some("FLOAT4".into());
        }
    }
    Some(upper)
}

pub fn resolve_database_transfer_type(
    source_db: crate::models::types::DatabaseType,
    source: &str,
    target_db: crate::models::types::DatabaseType,
    target: &str,
) -> TypeCompatibility {
    if target_db == crate::models::types::DatabaseType::ClickHouse {
        return TypeCompatibility::Unsupported;
    }
    let cross = source_db != target_db;
    let (Some(source), Some(target)) = (
        database_type_name(source_db, source, cross, false),
        database_type_name(target_db, target, cross, true),
    ) else {
        return TypeCompatibility::Unsupported;
    };
    if cross
        && !matches!(
            (parse(&source), parse(&target)),
            (
                Some(DataType::Integer { .. }),
                Some(DataType::Integer { .. })
            ) | (Some(DataType::Text(_)), Some(DataType::Text(_)))
                | (Some(DataType::Binary(_)), Some(DataType::Binary(_)))
        )
    {
        return TypeCompatibility::Unsupported;
    }
    resolve_transfer_type(&source, &target)
}

/// 将冻结源值变为目标原生读取所使用的无损规范值；此操作仅在跨类型传输的源快照写入前调用。
pub fn normalize_transfer_row(
    mut row: super::value::CanonicalRow,
    source: &super::metadata::DataMetadataSnapshot,
    target: &super::metadata::DataMetadataSnapshot,
    mapping: &super::metadata::ValidatedMapping,
) -> Result<super::value::CanonicalRow, String> {
    use super::value::DataValue;
    use crate::models::types::DatabaseType;
    if source.database_type == target.database_type {
        return Ok(row);
    }
    let mapped = mapping
        .tables
        .iter()
        .find(|m| m.target_table == row.table)
        .ok_or("invalid_mapping: 跨类型值没有对应表映射")?;
    let table = target
        .tables
        .iter()
        .find(|t| t.name == row.table)
        .ok_or("invalid_mapping: 跨类型目标表不存在")?;
    if row.values.len() != mapped.target_columns.len() {
        return Err("invalid_mapping: 跨类型行形状与映射不一致".into());
    }
    for (value, name) in row.values.iter_mut().zip(&mapped.target_columns) {
        let column = table
            .columns
            .iter()
            .find(|c| &c.name == name)
            .ok_or("invalid_mapping: 跨类型目标字段不存在")?;
        if matches!(value, DataValue::Null) {
            if !column.nullable {
                return Err("invalid_mapping: 源快照包含目标非空列无法接受的 NULL".into());
            }
            continue;
        }
        let declared = database_type_name(target.database_type, &column.declared_type, true, true)
            .ok_or("unsupported_capability: 目标类型尚未通过无损转换验收")?;
        let kind = parse(&declared).ok_or("unsupported_capability: 跨类型目标值类型不受支持")?;
        let converted = match (std::mem::replace(value, DataValue::Null), kind) {
            (DataValue::Bool(v), DataType::Boolean)
                if target.database_type == DatabaseType::Sqlite =>
            {
                DataValue::Int(i64::from(v))
            }
            (DataValue::Int(v), DataType::Boolean)
                if source.database_type == DatabaseType::Sqlite && matches!(v, 0 | 1) =>
            {
                DataValue::Bool(v == 1)
            }
            (v @ DataValue::Bool(_), DataType::Boolean) => v,
            (DataValue::Bool(v), DataType::Integer { unsigned: true, .. }) => {
                DataValue::UInt(u64::from(v))
            }
            (
                DataValue::Bool(v),
                DataType::Integer {
                    unsigned: false, ..
                },
            ) => DataValue::Int(i64::from(v)),
            (
                DataValue::UInt(v),
                DataType::Integer {
                    bits,
                    unsigned: false,
                },
            ) if v
                <= (if bits == 64 {
                    i64::MAX as u64
                } else {
                    (1u64 << (bits - 1)) - 1
                }) =>
            {
                DataValue::Int(v as i64)
            }
            (
                DataValue::Int(v),
                DataType::Integer {
                    bits,
                    unsigned: false,
                },
            ) if bits == 64 || (v >= -(1i64 << (bits - 1)) && v < (1i64 << (bits - 1))) => {
                DataValue::Int(v)
            }
            (
                DataValue::UInt(v),
                DataType::Integer {
                    bits,
                    unsigned: true,
                },
            ) if bits == 64 || v < (1u64 << bits) => {
                if target.database_type == DatabaseType::SqlServer {
                    DataValue::Int(
                        i64::try_from(v)
                            .map_err(|_| "unsupported_capability: 目标有符号表示溢出")?,
                    )
                } else {
                    DataValue::UInt(v)
                }
            }
            (
                DataValue::Int(v),
                DataType::Integer {
                    bits,
                    unsigned: true,
                },
            ) if v >= 0 && (bits == 64 || (v as u64) < (1u64 << bits)) => {
                if target.database_type == DatabaseType::SqlServer {
                    DataValue::Int(v)
                } else {
                    DataValue::UInt(v as u64)
                }
            }
            (DataValue::Text(v), DataType::Text(limit))
                if limit.is_none_or(|n| v.chars().count() as u64 <= n) =>
            {
                DataValue::Text(v)
            }
            (DataValue::Binary(v), DataType::Binary(limit))
                if limit.is_none_or(|n| v.len() as u64 <= n) =>
            {
                DataValue::Binary(v)
            }
            (DataValue::Decimal(v), DataType::Decimal { .. }) => {
                DataValue::Decimal(super::value::normalize_decimal(&v)?)
            }
            (DataValue::Float(bits), DataType::Float(_)) if f64::from_bits(bits).is_finite() => {
                DataValue::Float(bits)
            }
            (v @ DataValue::Temporal { .. }, DataType::Temporal { .. }) => v,
            (v @ DataValue::Uuid(_), DataType::Uuid) => v,
            _ => return Err("unsupported_capability: 源快照值无法无损表示为目标类型".into()),
        };
        *value = converted;
    }
    row.key.clear();
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::DatabaseType;
    #[test]
    fn database_ranges_account_for_sqlite_64bit_and_sqlserver_unsigned_tinyint() {
        assert_eq!(
            resolve_database_transfer_type(
                DatabaseType::Sqlite,
                "INTEGER",
                DatabaseType::Postgres,
                "INTEGER"
            ),
            TypeCompatibility::Unsupported
        );
        assert_eq!(
            resolve_database_transfer_type(
                DatabaseType::Sqlite,
                "INTEGER",
                DatabaseType::Postgres,
                "BIGINT"
            ),
            TypeCompatibility::Compatible
        );
        assert_eq!(
            resolve_database_transfer_type(
                DatabaseType::Postgres,
                "BIGINT",
                DatabaseType::Sqlite,
                "INTEGER"
            ),
            TypeCompatibility::Compatible
        );
        assert_eq!(
            resolve_database_transfer_type(
                DatabaseType::SqlServer,
                "TINYINT",
                DatabaseType::Postgres,
                "SMALLINT"
            ),
            TypeCompatibility::Compatible
        );
        assert_eq!(
            resolve_database_transfer_type(
                DatabaseType::Postgres,
                "SMALLINT",
                DatabaseType::SqlServer,
                "TINYINT"
            ),
            TypeCompatibility::Unsupported
        );
        assert_eq!(
            resolve_database_transfer_type(
                DatabaseType::MySql,
                "MEDIUMINT",
                DatabaseType::MySql,
                "INT"
            ),
            TypeCompatibility::Compatible
        );
        assert_eq!(
            resolve_database_transfer_type(
                DatabaseType::MySql,
                "INT",
                DatabaseType::MySql,
                "MEDIUMINT"
            ),
            TypeCompatibility::Unsupported
        );
        assert_eq!(
            resolve_database_transfer_type(
                DatabaseType::Sqlite,
                "NUMERIC(30,5)",
                DatabaseType::Postgres,
                "NUMERIC(30,5)"
            ),
            TypeCompatibility::Unsupported
        );
    }
    #[test]
    fn clickhouse_source_preserves_native_ranges_and_binary_meaning() {
        use DatabaseType::*;
        for (source, target_db, target) in [
            ("Int64", Postgres, "BIGINT"),
            ("UInt32", Sqlite, "INTEGER"),
            ("Nullable(String)", MySql, "LONGBLOB"),
            ("String", SqlServer, "VARBINARY(MAX)"),
        ] {
            assert_eq!(
                resolve_database_transfer_type(ClickHouse, source, target_db, target),
                TypeCompatibility::Compatible
            );
        }
        for (source, target_db, target) in [
            ("UInt64", Postgres, "BIGINT"),
            ("String", Postgres, "TEXT"),
            ("Decimal(30,10)", MySql, "DECIMAL(30,10)"),
            ("DateTime64(6,'UTC')", Postgres, "TIMESTAMP"),
            ("Float64", SqlServer, "FLOAT"),
            ("UUID", Postgres, "UUID"),
            ("JSON", Postgres, "JSON"),
        ] {
            assert_eq!(
                resolve_database_transfer_type(ClickHouse, source, target_db, target),
                TypeCompatibility::Unsupported
            );
        }
        assert_eq!(
            resolve_database_transfer_type(Sqlite, "INTEGER", ClickHouse, "Int64"),
            TypeCompatibility::Unsupported
        );
    }
    #[test]
    fn cross_type_values_match_target_storage_without_losing_integers_or_boolean_meaning() {
        use super::super::{
            metadata::{tests::metadata, ValidatedMapping, ValidatedTableMapping},
            value::{CanonicalRow, DataValue},
        };
        let mut source = metadata();
        source.database_type = DatabaseType::Postgres;
        let mut target = metadata();
        target.database_type = DatabaseType::Sqlite;
        target.tables[0].columns[1].declared_type = "BOOLEAN".into();
        let mapping = ValidatedMapping {
            tables: vec![ValidatedTableMapping {
                source_table: "t".into(),
                target_table: "t".into(),
                source_columns: vec!["id".into(), "v".into()],
                target_columns: vec!["id".into(), "v".into()],
                key_indices: vec![],
            }],
            insert_order: vec!["t".into()],
            delete_order: vec!["t".into()],
        };
        let row = CanonicalRow::new(
            "t".into(),
            vec![],
            vec![DataValue::Int(9007199254740993), DataValue::Bool(true)],
        )
        .unwrap();
        let normalized = normalize_transfer_row(row, &source, &target, &mapping).unwrap();
        assert_eq!(
            normalized.values,
            vec![DataValue::Int(9007199254740993), DataValue::Int(1)]
        );
        source.database_type = DatabaseType::MySql;
        target.database_type = DatabaseType::Postgres;
        target.tables[0].columns[0].declared_type = "BIGINT".into();
        target.tables[0].columns[1].declared_type = "TEXT".into();
        let row = CanonicalRow::new(
            "t".into(),
            vec![],
            vec![
                DataValue::UInt(9007199254740993),
                DataValue::Text("值".into()),
            ],
        )
        .unwrap();
        assert_eq!(
            normalize_transfer_row(row, &source, &target, &mapping)
                .unwrap()
                .values[0],
            DataValue::Int(9007199254740993)
        );
    }
    #[test]
    fn narrowing_or_semantic_loss_is_blocked() {
        for (a, b) in [
            ("BIGINT UNSIGNED", "BIGINT"),
            ("BIGINT", "INTEGER"),
            ("DECIMAL(30,10)", "DECIMAL(20,10)"),
            ("DECIMAL(20,10)", "DECIMAL(20,5)"),
            ("VARCHAR(200)", "VARCHAR(100)"),
            ("TIMESTAMP WITH TIME ZONE", "TIMESTAMP"),
            ("UUID", "TEXT"),
            ("JSON", "TEXT"),
            ("INTEGER[]", "TEXT"),
            ("GEOMETRY", "TEXT"),
        ] {
            assert_eq!(
                resolve_transfer_type(a, b),
                TypeCompatibility::Unsupported,
                "{a} -> {b}"
            );
        }
    }
    #[test]
    fn provable_range_containment_is_allowed() {
        for (a, b) in [
            ("SMALLINT", "BIGINT"),
            ("INTEGER", "BIGINT"),
            ("INTEGER UNSIGNED", "BIGINT"),
            ("DECIMAL(20,5)", "DECIMAL(30,10)"),
            ("VARCHAR(100)", "TEXT"),
            ("VARBINARY(12)", "BLOB"),
            ("BOOLEAN", "BOOLEAN"),
        ] {
            assert_eq!(
                resolve_transfer_type(a, b),
                TypeCompatibility::Compatible,
                "{a} -> {b}"
            );
        }
    }
}
#[cfg(test)]
mod sqlserver_types {
    use super::*;
    #[test]
    fn native_sqlserver_boolean_uuid_and_float_aliases_are_recognized() {
        for (a, b) in [
            ("BIT", "BIT"),
            ("UNIQUEIDENTIFIER", "UNIQUEIDENTIFIER"),
            ("FLOAT", "FLOAT"),
        ] {
            assert_eq!(
                resolve_transfer_type(a, b),
                TypeCompatibility::Compatible,
                "{a}"
            );
        }
    }
}
