use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DataValue {
    Null,
    Bool(bool),
    Int(i64),
    UInt(u64),
    Decimal(String),
    Float(u64),
    Text(String),
    Binary(Vec<u8>),
    Temporal { kind: String, value: String },
    Uuid([u8; 16]),
    Json(String),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalRow {
    pub table: String,
    pub key: Vec<DataValue>,
    pub values: Vec<DataValue>,
}
/// 定点小数只做十进制字符规范化，绝不经过浮点数。
pub fn normalize_decimal(input: &str) -> Result<String, String> {
    let (negative, digits) = if let Some(s) = input.strip_prefix('-') {
        (true, s)
    } else {
        (false, input.strip_prefix('+').unwrap_or(input))
    };
    let mut parts = digits.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next().unwrap_or("");
    if parts.next().is_some()
        || whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("unsupported_capability: 无效的精确小数".into());
    }
    let whole = whole.trim_start_matches('0');
    let whole = if whole.is_empty() { "0" } else { whole };
    let fraction = fraction.trim_end_matches('0');
    let sign = if negative && (whole != "0" || !fraction.is_empty()) {
        "-"
    } else {
        ""
    };
    Ok(if fraction.is_empty() {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{fraction}")
    })
}
fn field(output: &mut Vec<u8>, bytes: &[u8]) {
    output.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
    output.extend_from_slice(bytes);
}
fn values_bytes(output: &mut Vec<u8>, values: &[DataValue]) -> Result<(), String> {
    output.extend_from_slice(&(values.len() as u64).to_be_bytes());
    for value in values {
        field(output, &value.canonical_bytes()?);
    }
    Ok(())
}
impl DataValue {
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        match self {
            Self::Null => out.push(0),
            Self::Bool(v) => out.extend_from_slice(&[1, u8::from(*v)]),
            Self::Int(v) => {
                out.push(2);
                out.extend_from_slice(&v.to_be_bytes());
            }
            Self::UInt(v) => {
                out.push(3);
                out.extend_from_slice(&v.to_be_bytes());
            }
            Self::Decimal(v) => {
                out.push(4);
                field(&mut out, normalize_decimal(v)?.as_bytes());
            }
            Self::Float(v) => {
                out.push(5);
                out.extend_from_slice(&v.to_be_bytes());
            }
            Self::Text(v) => {
                out.push(6);
                field(&mut out, v.as_bytes());
            }
            Self::Binary(v) => {
                out.push(7);
                field(&mut out, v);
            }
            Self::Temporal { kind, value } => {
                out.push(8);
                field(&mut out, kind.as_bytes());
                field(&mut out, value.as_bytes());
            }
            Self::Uuid(v) => {
                out.push(9);
                out.extend_from_slice(v);
            }
            Self::Json(v) => {
                out.push(10);
                field(&mut out, v.as_bytes());
            }
        }
        Ok(out)
    }
    fn heap_size(&self) -> usize {
        match self {
            Self::Text(v) | Self::Decimal(v) | Self::Json(v) => v.capacity(),
            Self::Binary(v) => v.capacity(),
            Self::Temporal { kind, value } => kind.capacity().saturating_add(value.capacity()),
            _ => 0,
        }
    }
    pub fn encoded_size(&self) -> usize {
        match self {
            Self::Null => 1,
            Self::Bool(_) => 2,
            Self::Int(_) | Self::UInt(_) | Self::Float(_) => 9,
            Self::Uuid(_) => 17,
            Self::Text(s) | Self::Decimal(s) | Self::Json(s) => 9usize.saturating_add(s.len()),
            Self::Binary(b) => 9usize.saturating_add(b.len()),
            Self::Temporal { kind, value } => 17usize
                .saturating_add(kind.len())
                .saturating_add(value.len()),
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }
}
impl CanonicalRow {
    pub fn new(table: String, key: Vec<DataValue>, values: Vec<DataValue>) -> Result<Self, String> {
        let row = Self { table, key, values };
        row.canonical_bytes()?;
        Ok(row)
    }
    pub fn memory_size(&self) -> usize {
        std::mem::size_of::<Self>()
            .saturating_add(self.table.capacity())
            .saturating_add(
                self.key
                    .capacity()
                    .saturating_mul(std::mem::size_of::<DataValue>()),
            )
            .saturating_add(
                self.values
                    .capacity()
                    .saturating_mul(std::mem::size_of::<DataValue>()),
            )
            .saturating_add(
                self.key
                    .iter()
                    .chain(&self.values)
                    .fold(0usize, |n, v| n.saturating_add(v.heap_size())),
            )
    }
    pub fn encoded_size(&self) -> usize {
        self.key
            .iter()
            .chain(self.values.iter())
            .fold(24usize.saturating_add(self.table.len()), |n, v| {
                n.saturating_add(8).saturating_add(v.encoded_size())
            })
    }
    pub fn key_bytes(&self) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        field(&mut out, self.table.as_bytes());
        values_bytes(&mut out, &self.key)?;
        Ok(out)
    }
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, String> {
        let mut out = self.key_bytes()?;
        values_bytes(&mut out, &self.values)?;
        Ok(out)
    }
}
/// 仅解码内部带长度前缀的类型化记录；长度检查先于分配。
pub fn decode_row(input: &[u8]) -> Result<CanonicalRow, String> {
    struct Reader<'a> {
        data: &'a [u8],
        pos: usize,
    }
    impl<'a> Reader<'a> {
        fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
            let end = self
                .pos
                .checked_add(n)
                .ok_or("resource_limit: 快照记录长度无效")?;
            let out = self
                .data
                .get(self.pos..end)
                .ok_or("resource_limit: 快照记录损坏")?;
            self.pos = end;
            Ok(out)
        }
        fn number(&mut self) -> Result<u64, String> {
            Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
        }
        fn field(&mut self) -> Result<&'a [u8], String> {
            let n = usize::try_from(self.number()?).map_err(|_| "resource_limit: 快照长度超限")?;
            self.take(n)
        }
        fn string(&mut self) -> Result<String, String> {
            String::from_utf8(self.field()?.to_vec())
                .map_err(|_| "resource_limit: 快照文本损坏".into())
        }
        fn values(&mut self) -> Result<Vec<DataValue>, String> {
            let n =
                usize::try_from(self.number()?).map_err(|_| "resource_limit: 快照字段数无效")?;
            if n > self.data.len() / 9 {
                return Err("resource_limit: 快照字段数无效".into());
            }
            let mut out = Vec::with_capacity(n);
            for _ in 0..n {
                let mut v = Reader {
                    data: self.field()?,
                    pos: 0,
                };
                let tag = v.take(1)?[0];
                let value = match tag {
                    0 => DataValue::Null,
                    1 => DataValue::Bool(match v.take(1)?[0] {
                        0 => false,
                        1 => true,
                        _ => return Err("resource_limit: 布尔记录损坏".into()),
                    }),
                    2 => DataValue::Int(i64::from_be_bytes(v.take(8)?.try_into().unwrap())),
                    3 => DataValue::UInt(v.number()?),
                    4 => DataValue::Decimal(v.string()?),
                    5 => DataValue::Float(v.number()?),
                    6 => DataValue::Text(v.string()?),
                    7 => DataValue::Binary(v.field()?.to_vec()),
                    8 => DataValue::Temporal {
                        kind: v.string()?,
                        value: v.string()?,
                    },
                    9 => DataValue::Uuid(v.take(16)?.try_into().unwrap()),
                    10 => DataValue::Json(v.string()?),
                    _ => return Err("resource_limit: 快照类型损坏".into()),
                };
                if v.pos != v.data.len() {
                    return Err("resource_limit: 快照字段尾部损坏".into());
                }
                out.push(value);
            }
            Ok(out)
        }
    }
    let mut r = Reader {
        data: input,
        pos: 0,
    };
    let row = CanonicalRow {
        table: r.string()?,
        key: r.values()?,
        values: r.values()?,
    };
    if r.pos != input.len() {
        return Err("resource_limit: 快照记录尾部损坏".into());
    }
    Ok(row)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_values_and_length_prefixes_do_not_collide() {
        let values = [
            DataValue::Int(9007199254740993),
            DataValue::UInt(u64::MAX),
            DataValue::Null,
            DataValue::Text(String::new()),
            DataValue::Binary(vec![0]),
            DataValue::Text("null".into()),
        ];
        let encoded: Vec<_> = values
            .iter()
            .map(|v| v.canonical_bytes().unwrap())
            .collect();
        for i in 0..encoded.len() {
            for j in i + 1..encoded.len() {
                assert_ne!(encoded[i], encoded[j]);
            }
        }
        let a = CanonicalRow::new(
            "t".into(),
            vec![DataValue::Text("ab".into()), DataValue::Text("c".into())],
            vec![],
        )
        .unwrap();
        let b = CanonicalRow::new(
            "t".into(),
            vec![DataValue::Text("a".into()), DataValue::Text("bc".into())],
            vec![],
        )
        .unwrap();
        assert_ne!(a.key_bytes().unwrap(), b.key_bytes().unwrap());
    }
    #[test]
    fn decimals_are_exact_and_normalized_without_floats() {
        assert_eq!(
            DataValue::Decimal("+000123.45000".into())
                .canonical_bytes()
                .unwrap(),
            DataValue::Decimal("123.45".into())
                .canonical_bytes()
                .unwrap()
        );
        assert_ne!(
            DataValue::Decimal("9007199254740993.00000000001".into())
                .canonical_bytes()
                .unwrap(),
            DataValue::Decimal("9007199254740993.00000000002".into())
                .canonical_bytes()
                .unwrap()
        );
        assert!(DataValue::Decimal("1e999".into())
            .canonical_bytes()
            .is_err());
    }
    #[test]
    fn float_bits_and_temporal_precision_survive() {
        assert_ne!(
            DataValue::Float((-0.0f64).to_bits())
                .canonical_bytes()
                .unwrap(),
            DataValue::Float(0f64.to_bits()).canonical_bytes().unwrap()
        );
        for x in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let v = DataValue::Float(x.to_bits());
            assert_eq!(
                serde_json::from_slice::<DataValue>(&serde_json::to_vec(&v).unwrap()).unwrap(),
                v
            );
        }
        assert_ne!(
            DataValue::Temporal {
                kind: "offset".into(),
                value: "2026-10-19T12:00:00.123456+08:00".into()
            }
            .canonical_bytes()
            .unwrap(),
            DataValue::Temporal {
                kind: "offset".into(),
                value: "2026-10-19T12:00:00.123457+08:00".into()
            }
            .canonical_bytes()
            .unwrap()
        );
    }
}
