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
    // 原生名字相同不代表语义相同：MySQL TIMESTAMP 带会话时区，
    // SQL Server TIMESTAMP 是 rowversion；旧 DATETIME 也不是十进制定点时间。
    if cross {
        if (database != DatabaseType::SqlServer && upper == "BIT")
            || (database == DatabaseType::MySql && matches!(upper.as_str(), "BOOL" | "BOOLEAN"))
            || (database == DatabaseType::MySql && upper.starts_with("TIMESTAMP"))
            || (database == DatabaseType::SqlServer
                && matches!(
                    upper.as_str(),
                    "DATETIME" | "SMALLDATETIME" | "TIMESTAMP" | "ROWVERSION"
                ))
            || upper.contains("WITH TIME ZONE")
            || upper.starts_with("DATETIMEOFFSET")
        {
            return None;
        }
        if matches!(
            database,
            DatabaseType::Postgres | DatabaseType::MySql | DatabaseType::SqlServer
        ) {
            let naive = upper.strip_suffix(" WITHOUT TIME ZONE").unwrap_or(&upper);
            let base = naive.split('(').next().unwrap_or("");
            if base == "DATE" {
                return Some("DATE(0)".into());
            }
            let kind = match (database, base) {
                (DatabaseType::Postgres, "TIMESTAMP")
                | (DatabaseType::MySql, "DATETIME")
                | (DatabaseType::SqlServer, "DATETIME2") => Some("TIMESTAMP"),
                (_, "TIME") => Some("TIME"),
                _ => None,
            };
            if let Some(kind) = kind {
                let default_precision = match database {
                    DatabaseType::MySql => 0,
                    DatabaseType::SqlServer => 7,
                    _ => 6,
                };
                let precision = if naive == base {
                    default_precision
                } else {
                    naive
                        .strip_prefix(base)?
                        .strip_prefix('(')?
                        .strip_suffix(')')?
                        .parse::<u8>()
                        .ok()?
                };
                if precision
                    > if database == DatabaseType::SqlServer {
                        7
                    } else {
                        6
                    }
                {
                    return None;
                }
                return Some(format!("{kind}({precision})"));
            }
        }
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
        // MySQL 不写 fsp 表示秒精度；同类型传输也不能把默认精度当作 6。
        if matches!(upper.as_str(), "DATETIME" | "TIMESTAMP" | "TIME") {
            return Some(format!("{upper}(0)"));
        }
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
                | (
                    Some(DataType::Decimal { .. }),
                    Some(DataType::Decimal { .. })
                )
                | (Some(DataType::Boolean), Some(DataType::Boolean))
                | (Some(DataType::Boolean), Some(DataType::Integer { .. }))
                | (
                    Some(DataType::Temporal { .. }),
                    Some(DataType::Temporal { .. })
                )
        )
    {
        return TypeCompatibility::Unsupported;
    }
    if cross
        && matches!(
            (parse(&source), parse(&target)),
            (Some(DataType::Boolean), Some(DataType::Integer { .. }))
        )
    {
        return TypeCompatibility::Compatible;
    }
    resolve_transfer_type(&source, &target)
}

/// 跨库仅接收共同的公历日期/无时区时刻；不解释时区、不舍入、不把时长当时刻。
fn normalize_temporal(
    input: &str,
    kind: &str,
    precision: u8,
    target_db: crate::models::types::DatabaseType,
) -> Result<super::value::DataValue, String> {
    use crate::models::types::DatabaseType;
    let error = || "unsupported_capability: 日期时间超出目标范围、精度或无时区语义".to_string();
    if !input.is_ascii() {
        return Err(error());
    }
    let (date, clock) = match kind {
        "DATE" => (Some(input), None),
        "TIMESTAMP" if input.len() > 11 && matches!(input.as_bytes()[10], b' ' | b'T') => {
            (Some(&input[..10]), Some(&input[11..]))
        }
        "TIME" => (None, Some(input)),
        _ => return Err(error()),
    };
    if let Some(date) = date {
        if date.len() != 10 || date.as_bytes()[4] != b'-' || date.as_bytes()[7] != b'-' {
            return Err(error());
        }
        let year: i32 = date[..4].parse().map_err(|_| error())?;
        let month: u8 = date[5..7].parse().map_err(|_| error())?;
        let day: u8 = date[8..].parse().map_err(|_| error())?;
        if !(1..=9999).contains(&year) || (target_db == DatabaseType::MySql && year < 1000) {
            return Err(error());
        }
        time::Date::from_calendar_date(
            year,
            time::Month::try_from(month).map_err(|_| error())?,
            day,
        )
        .map_err(|_| error())?;
    }
    let mut value = date.unwrap_or("").to_string();
    if let Some(clock) = clock {
        let (whole, fraction) = clock.split_once('.').unwrap_or((clock, ""));
        if whole.len() != 8 || whole.as_bytes()[2] != b':' || whole.as_bytes()[5] != b':' {
            return Err(error());
        }
        let hour: u8 = whole[..2].parse().map_err(|_| error())?;
        let minute: u8 = whole[3..5].parse().map_err(|_| error())?;
        let second: u8 = whole[6..].parse().map_err(|_| error())?;
        if hour > 23 || minute > 59 || second > 59 || !fraction.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(error());
        }
        let fraction = fraction.trim_end_matches('0');
        if fraction.len() > usize::from(precision) {
            return Err(error());
        }
        if date.is_some() {
            value.push(if target_db == DatabaseType::SqlServer {
                'T'
            } else {
                ' '
            });
        }
        value.push_str(whole);
        let fraction = if target_db == DatabaseType::Postgres
            || (target_db == DatabaseType::SqlServer && fraction.is_empty())
        {
            fraction.to_string()
        } else {
            format!("{fraction:0<width$}", width = usize::from(precision))
        };
        if !fraction.is_empty() {
            value.push('.');
            value.push_str(&fraction);
        }
    }
    let kind = match kind {
        "DATE" => "date",
        "TIME" => "time",
        _ if target_db == DatabaseType::Postgres => "timestamp",
        _ if target_db == DatabaseType::SqlServer => "datetime2",
        _ => "datetime",
    };
    Ok(super::value::DataValue::Temporal {
        kind: kind.into(),
        value: if target_db == DatabaseType::MySql {
            super::value::normalize_mysql_temporal(&value)
        } else {
            value
        },
    })
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
    for (index, (value, name)) in row
        .values
        .iter_mut()
        .zip(&mapped.target_columns)
        .enumerate()
    {
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
        if source.database_type == DatabaseType::Sqlite {
            let source_column = source
                .tables
                .iter()
                .find(|t| t.name == mapped.source_table)
                .and_then(|t| {
                    t.columns
                        .iter()
                        .find(|c| c.name == mapped.source_columns[index])
                });
            if source_column
                .is_some_and(|c| matches!(parse(&c.declared_type), Some(DataType::Boolean)))
                && !matches!(value, DataValue::Int(0 | 1) | DataValue::Bool(_))
            {
                return Err("unsupported_capability: SQLite BOOLEAN 只能无损传输整数 0/1".into());
            }
        }
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
                if target.database_type == DatabaseType::SqlServer {
                    DataValue::Int(i64::from(v))
                } else {
                    DataValue::UInt(u64::from(v))
                }
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
            (DataValue::Decimal(v), DataType::Decimal { precision, scale }) => {
                let v = super::value::normalize_decimal(&v)?;
                let unsigned = v.strip_prefix('-').unwrap_or(&v);
                let (whole, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
                if whole.trim_start_matches('0').len() > usize::from(precision - scale)
                    || fraction.len() > usize::from(scale)
                {
                    return Err("unsupported_capability: 精确小数超出目标精度或小数位".into());
                }
                DataValue::Decimal(v)
            }
            (DataValue::Float(bits), DataType::Float(_)) if f64::from_bits(bits).is_finite() => {
                DataValue::Float(bits)
            }
            (DataValue::Temporal { value, .. }, DataType::Temporal { kind, precision }) => {
                normalize_temporal(&value, &kind, precision, target.database_type)?
            }
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
    #[test]
    fn mysql_default_temporal_precision_is_zero_for_same_type_transfers() {
        use crate::models::types::DatabaseType::MySql;
        for kind in ["DATETIME", "TIMESTAMP", "TIME"] {
            assert_eq!(
                resolve_database_transfer_type(MySql, &format!("{kind}(6)"), MySql, kind),
                TypeCompatibility::Unsupported,
                "{kind} 缺省精度为秒，不能接收微秒声明"
            );
            assert_eq!(
                resolve_database_transfer_type(MySql, kind, MySql, &format!("{kind}(6)")),
                TypeCompatibility::Compatible
            );
        }
    }
    use crate::models::types::DatabaseType;
    #[test]
    fn exact_decimal_boolean_and_naive_temporal_cross_types_are_supported() {
        use DatabaseType::*;
        for (source_db, source, target_db, target) in [
            (Postgres, "NUMERIC(30,10)", MySql, "DECIMAL(38,12)"),
            (MySql, "DECIMAL(30,10)", SqlServer, "NUMERIC(38,12)"),
            (SqlServer, "NUMERIC(30,10)", Postgres, "NUMERIC(38,12)"),
            (Postgres, "BOOLEAN", SqlServer, "BIT"),
            (SqlServer, "BIT", Sqlite, "BOOLEAN"),
            (Sqlite, "BOOLEAN", Postgres, "BOOLEAN"),
            (Postgres, "BOOLEAN", MySql, "TINYINT"),
            (MySql, "DATE", Postgres, "DATE"),
            (SqlServer, "DATE", MySql, "DATE"),
            (
                Postgres,
                "TIMESTAMP(3) WITHOUT TIME ZONE",
                SqlServer,
                "DATETIME2(6)",
            ),
            (
                MySql,
                "DATETIME(6)",
                Postgres,
                "TIMESTAMP WITHOUT TIME ZONE",
            ),
            (SqlServer, "TIME(6)", Postgres, "TIME WITHOUT TIME ZONE"),
            (Postgres, "TIME(3) WITHOUT TIME ZONE", MySql, "TIME(6)"),
        ] {
            assert_eq!(
                resolve_database_transfer_type(source_db, source, target_db, target),
                TypeCompatibility::Compatible,
                "{source_db:?} {source} -> {target_db:?} {target}"
            );
        }
    }
    #[test]
    fn ambiguous_boolean_temporal_and_narrowing_cross_types_stay_blocked() {
        use DatabaseType::*;
        for (source_db, source, target_db, target) in [
            (MySql, "TINYINT", Postgres, "BOOLEAN"),
            (MySql, "BIT", Postgres, "BOOLEAN"),
            (Postgres, "NUMERIC(30,10)", SqlServer, "DECIMAL(30,5)"),
            (Postgres, "NUMERIC", MySql, "DECIMAL(65,30)"),
            (Sqlite, "DECIMAL(30,10)", Postgres, "NUMERIC(30,10)"),
            (Postgres, "NUMERIC(30,10)", Sqlite, "NUMERIC(30,10)"),
            (SqlServer, "TIME(7)", Postgres, "TIME WITHOUT TIME ZONE"),
            (Postgres, "TIMESTAMP WITHOUT TIME ZONE", MySql, "DATETIME"),
            (
                MySql,
                "TIMESTAMP(6)",
                Postgres,
                "TIMESTAMP(6) WITHOUT TIME ZONE",
            ),
            (
                Postgres,
                "TIMESTAMP WITH TIME ZONE",
                SqlServer,
                "DATETIMEOFFSET(7)",
            ),
            (
                SqlServer,
                "DATETIME",
                Postgres,
                "TIMESTAMP WITHOUT TIME ZONE",
            ),
            (
                SqlServer,
                "TIMESTAMP",
                Postgres,
                "TIMESTAMP WITHOUT TIME ZONE",
            ),
            (Sqlite, "DATE", MySql, "DATE"),
        ] {
            assert_eq!(
                resolve_database_transfer_type(source_db, source, target_db, target),
                TypeCompatibility::Unsupported,
                "{source_db:?} {source} -> {target_db:?} {target}"
            );
        }
    }
    fn normalize_test_value(
        value: super::super::value::DataValue,
        source_db: DatabaseType,
        target_db: DatabaseType,
        target_type: &str,
    ) -> Result<super::super::value::DataValue, String> {
        use super::super::{
            metadata::{tests::metadata, ValidatedMapping, ValidatedTableMapping},
            value::{CanonicalRow, DataValue},
        };
        let mut source = metadata();
        source.database_type = source_db;
        if source_db == DatabaseType::Sqlite {
            source.tables[0].columns[1].declared_type = "BOOLEAN".into();
        }
        let mut target = metadata();
        target.database_type = target_db;
        target.tables[0].columns[1].declared_type = target_type.into();
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
        let row = CanonicalRow::new("t".into(), vec![], vec![DataValue::Int(1), value])?;
        Ok(normalize_transfer_row(row, &source, &target, &mapping)?
            .values
            .remove(1))
    }
    #[test]
    fn frozen_exact_values_reject_overflow_invalid_boolean_and_temporal_loss() {
        use super::super::value::DataValue;
        use DatabaseType::*;
        for decimal in ["123456.78", "1.234", "-100000.00"] {
            assert!(normalize_test_value(
                DataValue::Decimal(decimal.into()),
                Postgres,
                MySql,
                "DECIMAL(7,2)"
            )
            .is_err());
        }
        assert!(normalize_test_value(DataValue::Int(2), Sqlite, Postgres, "BOOLEAN").is_err());
        assert!(normalize_test_value(DataValue::Int(2), Sqlite, MySql, "TINYINT").is_err());
        for (kind, value, target) in [
            ("date", "0000-00-00", "DATE"),
            ("date", "infinity", "DATE"),
            ("date", "0999-12-31", "DATE"),
            ("timestamp", "2026-01-01 00:00:00.123456", "DATETIME(3)"),
            ("time", "24:00:00", "TIME(6)"),
            ("time", "-01:00:00", "TIME(6)"),
            ("time", "12:00:60", "TIME(6)"),
        ] {
            assert!(
                normalize_test_value(
                    DataValue::Temporal {
                        kind: kind.into(),
                        value: value.into()
                    },
                    Postgres,
                    MySql,
                    target
                )
                .is_err(),
                "{value}"
            );
        }
    }
    #[test]
    fn sqlserver_tinyint_boolean_values_use_native_integer_snapshot() {
        use super::super::value::DataValue;
        use DatabaseType::*;
        assert_eq!(
            normalize_test_value(DataValue::Bool(true), Postgres, SqlServer, "TINYINT").unwrap(),
            DataValue::Int(1)
        );
        assert_eq!(
            normalize_test_value(DataValue::Bool(false), Postgres, SqlServer, "TINYINT").unwrap(),
            DataValue::Int(0)
        );
        assert_eq!(
            normalize_test_value(DataValue::Bool(true), Postgres, MySql, "TINYINT UNSIGNED")
                .unwrap(),
            DataValue::UInt(1)
        );
        assert_eq!(
            normalize_test_value(DataValue::Int(1), Sqlite, SqlServer, "TINYINT").unwrap(),
            DataValue::Int(1)
        );
    }
    #[test]
    fn frozen_temporal_values_match_the_target_native_snapshot_format() {
        use super::super::value::DataValue;
        use DatabaseType::*;
        for (source, target_db, target_type, target_kind, target_value) in [
            (
                "2026-10-21 12:34:56.123400",
                Postgres,
                "TIMESTAMP(6) WITHOUT TIME ZONE",
                "timestamp",
                "2026-10-21 12:34:56.1234",
            ),
            (
                "2026-10-21T12:34:56.12",
                MySql,
                "DATETIME(6)",
                "datetime",
                "2026-10-21 12:34:56.12",
            ),
            (
                "2026-10-21 12:34:56.1234",
                SqlServer,
                "DATETIME2(6)",
                "datetime2",
                "2026-10-21T12:34:56.123400",
            ),
        ] {
            let source_db = if target_db == SqlServer {
                Postgres
            } else {
                SqlServer
            };
            assert_eq!(
                normalize_test_value(
                    DataValue::Temporal {
                        kind: "datetime2".into(),
                        value: source.into()
                    },
                    source_db,
                    target_db,
                    target_type
                )
                .unwrap(),
                DataValue::Temporal {
                    kind: target_kind.into(),
                    value: target_value.into()
                }
            );
        }
    }
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
