//! SQL 查询结果预算：行数与列名、行数组的紧凑 JSON 字节数。

use serde::Serialize;
use serde_json::Value as JsonValue;
use std::io::{self, Write};

pub const MAX_RESULT_ROWS: usize = 100_000;
pub const MAX_RESULT_BYTES: usize = 32 * 1024 * 1024;

pub struct ResultBudget {
    rows: usize,
    bytes: usize,
    max_bytes: usize,
    max_rows: usize,
}

impl Default for ResultBudget {
    fn default() -> Self {
        Self::with_limits(MAX_RESULT_ROWS, MAX_RESULT_BYTES)
    }
}

impl ResultBudget {
    pub fn with_limits(max_rows: usize, max_bytes: usize) -> Self {
        Self {
            rows: 0,
            bytes: 2,
            max_rows,
            max_bytes,
        }
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn add_columns(&mut self, columns: &[String]) -> Result<(), String> {
        self.add_json(columns, 0)
    }

    pub fn add_row(&mut self, row: &[JsonValue]) -> Result<(), String> {
        if self.rows >= self.max_rows {
            return Err(format!(
                "查询结果超过最大行数 {}，请限制返回行数或缩小范围后重试",
                self.max_rows
            ));
        }
        self.add_json(row, usize::from(self.rows > 0))?;
        self.rows += 1;
        Ok(())
    }

    fn add_json(
        &mut self,
        value: &(impl Serialize + ?Sized),
        separator: usize,
    ) -> Result<(), String> {
        let mut counter = BoundedCounter {
            bytes: self.bytes().saturating_add(separator),
            limit: self.max_bytes,
        };
        // 仅计算序列化长度，不分配一份 JSON 字符串；超过预算立即停止计数。
        serde_json::to_writer(&mut counter, value).map_err(|_| result_bytes_exceeded())?;
        self.bytes = counter.bytes;
        Ok(())
    }
}

/// 在首次预算或驱动错误处停止拉取，不返回已缓存的部分结果。
pub async fn collect_rows<S>(
    stream: S,
    budget: &mut ResultBudget,
) -> Result<Vec<Vec<JsonValue>>, String>
where
    S: futures_util::Stream<Item = Result<Vec<JsonValue>, String>>,
{
    use futures_util::TryStreamExt;
    futures_util::pin_mut!(stream);
    let mut rows = Vec::new();
    while let Some(values) = stream.try_next().await? {
        budget.add_row(&values)?;
        rows.push(values);
        if rows.len() % 256 == 0 {
            tokio::task::yield_now().await;
        }
    }
    Ok(rows)
}

pub fn result_bytes_exceeded() -> String {
    format!(
        "查询结果超过最大字节数 {}（32 MiB），请减少查询列、限制返回行数或缩小范围后重试",
        MAX_RESULT_BYTES
    )
}

struct BoundedCounter {
    bytes: usize,
    limit: usize,
}

impl Write for BoundedCounter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let next = self.bytes.saturating_add(buf.len());
        if next > self.limit {
            return Err(io::Error::other("result byte limit exceeded"));
        }
        self.bytes = next;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn result_budget_stream_stops_polling_on_limit_and_returns_no_partial_page() {
        use futures_util::StreamExt;
        use std::cell::Cell;
        for (max_rows, max_bytes) in [(1, 100), (100, 7)] {
            let polls = Cell::new(0);
            let stream = futures_util::stream::iter([
                Ok(vec![json!(1)]),
                Ok(vec![json!(2)]),
                Err("不得读取的剩余结果".to_string()),
            ])
            .inspect(|_| polls.set(polls.get() + 1));
            let mut budget = ResultBudget::with_limits(max_rows, max_bytes);
            let result = collect_rows(stream, &mut budget).await;
            assert!(result.unwrap_err().contains("查询结果超过"));
            assert_eq!(polls.get(), 2);
        }
    }

    #[test]
    fn result_budget_small_limits_accept_exact_boundary_and_reject_one_more() {
        let mut budget = ResultBudget::with_limits(1, 10);
        budget.add_columns(&["x".into()]).unwrap();
        budget.add_row(&[json!(1)]).unwrap();
        assert_eq!(budget.bytes(), 10);
        assert!(budget.add_row(&[]).unwrap_err().contains("最大行数"));
        let mut budget = ResultBudget::with_limits(2, 9);
        budget.add_columns(&["x".into()]).unwrap();
        assert!(budget
            .add_row(&[json!(1)])
            .unwrap_err()
            .contains("最大字节数"));
        assert_eq!(budget.bytes(), 7);
        assert_eq!(budget.rows, 0);
    }

    #[test]
    fn result_budget_counts_binary_display_and_private_errors() {
        let mut budget = ResultBudget::with_limits(2, 30);
        budget.add_columns(&["值".into()]).unwrap();
        budget
            .add_row(&[json!("中\""), JsonValue::Null, json!("0x00")])
            .unwrap();
        assert_eq!(budget.bytes(), 30);
        let error = budget
            .add_row(&[json!("secret-sql-field-connection")])
            .unwrap_err();
        assert!(error.contains("最大字节数"));
        assert!(!error.contains("secret"));
    }

    #[test]
    fn row_limit_accepts_boundary_and_rejects_next_row() {
        let mut budget = ResultBudget::default();
        budget.add_columns(&["id".into()]).unwrap();
        for _ in 0..100_000 {
            budget.add_row(&[json!(1)]).unwrap();
        }
        assert!(budget
            .add_row(&[json!(2)])
            .unwrap_err()
            .contains("最大行数"));
    }

    #[test]
    fn bytes_include_utf8_escaping_nulls_and_array_separators() {
        // 列 ["值"] 为 7 字节；行 [["中\\\"",null]] 为 16 字节。
        let mut budget = ResultBudget {
            rows: 0,
            bytes: 2,
            max_bytes: 23,
            max_rows: MAX_RESULT_ROWS,
        };
        budget.add_columns(&["值".into()]).unwrap();
        budget.add_row(&[json!("中\""), JsonValue::Null]).unwrap();
        assert_eq!(budget.bytes, 23);
        assert!(budget.add_row(&[]).unwrap_err().contains("最大字节数"));
        assert_eq!(budget.rows, 1);
        assert_eq!(budget.bytes, 23);
    }

    #[test]
    fn oversized_columns_and_single_cells_are_rejected() {
        let mut budget = ResultBudget {
            rows: 0,
            bytes: 2,
            max_bytes: 8,
            max_rows: MAX_RESULT_ROWS,
        };
        assert!(budget.add_columns(&["过长列名".into()]).is_err());
        let mut budget = ResultBudget {
            rows: 0,
            bytes: 2,
            max_bytes: 8,
            max_rows: MAX_RESULT_ROWS,
        };
        assert!(budget.add_row(&[json!("12345")]).is_err());
        assert_eq!(budget.rows, 0);
    }

    #[test]
    fn nested_json_and_control_characters_match_wire_size() {
        let mut budget = ResultBudget::default();
        let columns = vec!["name\n".to_string()];
        let rows = vec![
            vec![json!({"nested": [true, 42, "\u{0}\n\\"]})],
            vec![json!(-1.5)],
        ];
        budget.add_columns(&columns).unwrap();
        for row in &rows {
            budget.add_row(row).unwrap();
        }
        assert_eq!(
            budget.bytes,
            serde_json::to_vec(&columns).unwrap().len() + serde_json::to_vec(&rows).unwrap().len()
        );
    }
}
