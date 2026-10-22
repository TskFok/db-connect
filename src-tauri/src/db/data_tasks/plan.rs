use super::{
    metadata::{DataMetadataSnapshot, ValidatedMapping},
    spool::{SortedSpool, SpoolHandle},
    value::CanonicalRow,
};
use crate::models::data_tasks::*;
#[derive(Clone, Debug)]
pub struct Operation {
    pub kind: DataDiffOperation,
    pub old: Option<CanonicalRow>,
    pub new: Option<CanonicalRow>,
}
impl Operation {
    pub fn from_row(row: &CanonicalRow) -> Result<Self, String> {
        let kind = match row.key.first() {
            Some(super::value::DataValue::Text(s)) => match s.as_str() {
                "insert" => DataDiffOperation::Insert,
                "update" => DataDiffOperation::Update,
                "delete" => DataDiffOperation::Delete,
                "retain" => DataDiffOperation::Retain,
                _ => return Err("invalid_mapping: 差异操作损坏".into()),
            },
            _ => return Err("invalid_mapping: 差异记录损坏".into()),
        };
        if !matches!(row.key.get(1), Some(super::value::DataValue::UInt(_))) {
            return Err("invalid_mapping: 差异定位损坏".into());
        }
        let payload = CanonicalRow {
            table: row.table.clone(),
            key: row.key[2..].to_vec(),
            values: row.values.clone(),
        };
        Ok(match kind {
            DataDiffOperation::Insert => Self {
                kind,
                old: None,
                new: Some(payload),
            },
            DataDiffOperation::Update => Self {
                kind,
                old: Some(CanonicalRow {
                    table: payload.table.clone(),
                    key: payload.key.clone(),
                    values: vec![],
                }),
                new: Some(payload),
            },
            _ => Self {
                kind,
                old: Some(payload),
                new: None,
            },
        })
    }
}
#[derive(Clone, Debug)]
pub struct StoredDataPlan {
    pub request: DataTaskRequest,
    pub mapping: ValidatedMapping,
    pub preview: DataTaskPreview,
    pub source: SortedSpool,
    pub target: SortedSpool,
    pub target_full: SortedSpool,
    pub operations: SpoolHandle,
    pub expected: SortedSpool,
    pub source_metadata: DataMetadataSnapshot,
    pub target_metadata: DataMetadataSnapshot,
}
#[derive(Default)]
struct Counts {
    source: u64,
    target: u64,
    insert: u64,
    update: u64,
    delete: u64,
    unchanged: u64,
    retained: u64,
    expected: u64,
}
impl Counts {
    fn ipc(&self) -> DataTaskCounts {
        DataTaskCounts {
            source_rows: self.source.to_string(),
            target_rows: self.target.to_string(),
            inserted: self.insert.to_string(),
            updated: self.update.to_string(),
            deleted: self.delete.to_string(),
            unchanged: self.unchanged.to_string(),
            retained: self.retained.to_string(),
            written: (self.insert + self.update + self.delete).to_string(),
            verified: self.expected.to_string(),
        }
    }
}
fn check_rows(spool: &SpoolHandle, mapping: &ValidatedMapping, unique: bool) -> Result<(), String> {
    let mut c = spool.cursor()?;
    let mut previous = None;
    while let Some(row) = c.next_row()? {
        let table = mapping
            .tables
            .iter()
            .find(|t| t.target_table == row.table)
            .ok_or("invalid_mapping: 快照包含未选择表")?;
        if row.values.len() != table.target_columns.len()
            || row.key.len() != table.key_indices.len()
        {
            return Err("invalid_mapping: 快照投影与映射不一致".into());
        }
        for (i, v) in table.key_indices.iter().zip(&row.key) {
            if row.values[*i].canonical_bytes()? != v.canonical_bytes()? {
                return Err("invalid_mapping: 快照定位键不匹配".into());
            }
        }
        if unique {
            if row.key.is_empty() || row.key.iter().any(super::value::DataValue::is_null) {
                return Err("invalid_mapping: 同步定位键为空".into());
            }
            if row.key.iter().any(|v| {
                matches!(
                    v,
                    super::value::DataValue::Float(_)
                        | super::value::DataValue::Json(_)
                        | super::value::DataValue::Temporal { .. }
                )
            }) {
                return Err(
                    "unsupported_capability: 无法证明浮点或 JSON 定位键与数据库唯一性语义一致"
                        .into(),
                );
            }
            let key = row.key_bytes()?;
            if previous.as_ref() == Some(&key) {
                return Err("invalid_mapping: 同步定位键重复".into());
            }
            previous = Some(key);
        }
    }
    Ok(())
}
fn operation(
    writer: &mut super::spool::SpoolWriter,
    kind: DataDiffOperation,
    row: &CanonicalRow,
    target_index: u64,
) -> Result<(), String> {
    use super::value::DataValue;
    let name = match kind {
        DataDiffOperation::Insert => "insert",
        DataDiffOperation::Update => "update",
        DataDiffOperation::Delete => "delete",
        DataDiffOperation::Retain => "retain",
    };
    let mut key = vec![DataValue::Text(name.into()), DataValue::UInt(target_index)];
    key.extend(row.key.clone());
    writer.push_batch(&[CanonicalRow {
        table: row.table.clone(),
        key,
        values: row.values.clone(),
    }])
}
/// 输入快照已由适配器按目标字段顺序投影；此函数只操作本地加密文件。
#[allow(clippy::too_many_arguments)]
pub fn build_plan(
    task_id: &str,
    request: DataTaskRequest,
    mapping: ValidatedMapping,
    source_metadata: DataMetadataSnapshot,
    target_metadata: DataMetadataSnapshot,
    source: SpoolHandle,
    target: SpoolHandle,
    target_full: SpoolHandle,
) -> Result<StoredDataPlan, String> {
    let verified = super::metadata::validate_mapping(&request, &source_metadata, &target_metadata)?;
    if serde_json::to_vec(&verified).map_err(|_| "invalid_mapping: 映射编码失败")?
        != serde_json::to_vec(&mapping).map_err(|_| "invalid_mapping: 映射编码失败")?
    {
        return Err("invalid_mapping: 映射未通过后端验证".into());
    }
    let source = super::spool::external_sort(&source)?;
    let target = super::spool::external_sort(&target)?;
    let target_full = super::spool::external_sort(&target_full)?;
    check_rows(
        &source.spool,
        &mapping,
        request.kind == DataTaskKind::RowSync,
    )?;
    check_rows(
        &target.spool,
        &mapping,
        request.kind == DataTaskKind::RowSync,
    )?;
    let mut counts: std::collections::BTreeMap<String, Counts> = mapping
        .tables
        .iter()
        .map(|m| (m.target_table.clone(), Counts::default()))
        .collect();
    let mut operations = source.spool.writer_with_overhead(128)?;
    let mut expected = source.spool.writer()?;
    let mut sc = source.spool.cursor()?;
    let mut tc = target.spool.cursor()?;
    if request.kind == DataTaskKind::RowSync {
        let mut s = sc.next_row()?;
        let mut t = tc.next_row()?;
        let mut ti = 0;
        while s.is_some() || t.is_some() {
            let ordering = match (&s, &t) {
                (Some(s), Some(t)) => s.key_bytes()?.cmp(&t.key_bytes()?),
                (Some(_), None) => std::cmp::Ordering::Less,
                _ => std::cmp::Ordering::Greater,
            };
            match ordering {
                std::cmp::Ordering::Less => {
                    let r = s.as_ref().unwrap();
                    let c = counts.get_mut(&r.table).unwrap();
                    c.source += 1;
                    c.insert += 1;
                    c.expected += 1;
                    operation(&mut operations, DataDiffOperation::Insert, r, u64::MAX)?;
                    expected.push_batch(std::slice::from_ref(r))?;
                    s = sc.next_row()?;
                }
                std::cmp::Ordering::Equal => {
                    let r = s.as_ref().unwrap();
                    let old = t.as_ref().unwrap();
                    let c = counts.get_mut(&r.table).unwrap();
                    c.source += 1;
                    c.target += 1;
                    c.expected += 1;
                    if r.canonical_bytes()? == old.canonical_bytes()? {
                        c.unchanged += 1;
                    } else {
                        c.update += 1;
                        operation(&mut operations, DataDiffOperation::Update, r, ti)?;
                    }
                    expected.push_batch(std::slice::from_ref(r))?;
                    s = sc.next_row()?;
                    t = tc.next_row()?;
                    ti += 1;
                }
                std::cmp::Ordering::Greater => {
                    let r = t.as_ref().unwrap();
                    let c = counts.get_mut(&r.table).unwrap();
                    c.target += 1;
                    if request.mode == DataTaskMode::Mirror {
                        c.delete += 1;
                        operation(&mut operations, DataDiffOperation::Delete, r, ti)?;
                    } else {
                        c.retained += 1;
                        c.expected += 1;
                        operation(&mut operations, DataDiffOperation::Retain, r, ti)?;
                        expected.push_batch(std::slice::from_ref(r))?;
                    }
                    t = tc.next_row()?;
                    ti += 1;
                }
            }
        }
    } else {
        while let Some(row) = sc.next_row()? {
            let c = counts.get_mut(&row.table).unwrap();
            c.source += 1;
            c.insert += 1;
            c.expected += 1;
            operation(&mut operations, DataDiffOperation::Insert, &row, u64::MAX)?;
            expected.push_batch(&[row])?;
        }
        let mut ti = 0;
        while let Some(row) = tc.next_row()? {
            let c = counts.get_mut(&row.table).unwrap();
            c.target += 1;
            if request.mode == DataTaskMode::Replace {
                c.delete += 1;
                operation(&mut operations, DataDiffOperation::Delete, &row, ti)?;
            } else {
                c.retained += 1;
                c.expected += 1;
                expected.push_batch(&[row])?;
            }
            ti += 1;
        }
    }
    let operations = operations.finish()?;
    let expected = super::spool::external_sort(&expected.finish()?)?;
    let mut risks = Vec::new();
    if source_metadata.database_type == crate::models::types::DatabaseType::ClickHouse {
        risks.push(DataTaskRisk{id:"source_without_transaction_snapshot".into(),message:"ClickHouse 源仅提供单次集合读取语义，不保证跨表事务一致快照；目标写入仍由完整事务保护".into(),required:true});
    }
    if matches!(request.mode, DataTaskMode::Mirror | DataTaskMode::Replace) {
        risks.push(DataTaskRisk {
            id: "destructive_write".into(),
            message: "此模式会删除预览范围内的目标数据".into(),
            required: true,
        });
        for (name, c) in &counts {
            if c.source == 0 && c.target > 0 {
                risks.push(DataTaskRisk {
                    id: format!("empty_source:{name}"),
                    message: format!("源表为空，将清空目标表 {name} 的 {} 行", c.target),
                    required: true,
                });
            }
        }
    }
    if target_metadata.tables.iter().any(|t| {
        mapping.tables.iter().any(|m| m.target_table == t.name)
            && t.columns.iter().any(|c| c.identity)
    }) {
        risks.push(DataTaskRisk {
            id: "generator_gaps".into(),
            message: "数据库自增或序列计数可能在回滚后留下间隙，但不会回退".into(),
            required: false,
        });
    }
    let tables = mapping
        .tables
        .iter()
        .map(|m| DataTablePreview {
            table_id: m.target_table.clone(),
            source_table: m.source_table.clone(),
            target_table: m.target_table.clone(),
            counts: counts[&m.target_table].ipc(),
        })
        .collect();
    let now = super::now_ms();
    let preview=DataTaskPreview{task_id:task_id.into(),plan_id:uuid::Uuid::new_v4().to_string(),fingerprint:String::new(),source:request.source.clone(),target:request.target.clone(),kind:request.kind,mode:request.mode,tables,source_captured_at:source.spool.captured_at_ms().to_string(),target_captured_at:target.spool.captured_at_ms().to_string(),expires_at:now.saturating_add(15*60*1000).to_string(),risks,blockers:vec![],can_execute:true,sql_examples:vec!["以下为参数化操作样本，实际标识符由后端校验并按方言引用：INSERT INTO <目标表> (<映射列>) VALUES (?, …)".into()]};
    let mut plan = StoredDataPlan {
        request,
        mapping,
        preview,
        source,
        target,
        target_full,
        operations,
        expected,
        source_metadata,
        target_metadata,
    };
    plan.preview.fingerprint = fingerprint(&plan)?;
    Ok(plan)
}
/// 仅包含非敏感配置摘要、完整元数据与内容摘要，不包含路径、密钥和原始行值。
pub fn fingerprint(plan: &StoredDataPlan) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    let mut request = plan.request.clone();
    request
        .mappings
        .sort_by(|a, b| a.target_table.cmp(&b.target_table));
    for m in &mut request.mappings {
        m.columns
            .sort_by(|a, b| a.target_column.cmp(&b.target_column));
    }
    let normalize = |m: &DataMetadataSnapshot| {
        let mut m = m.clone();
        m.tables.sort_by(|a, b| a.name.cmp(&b.name));
        for t in &mut m.tables {
            t.columns.sort_by(|a, b| a.name.cmp(&b.name));
            t.foreign_keys
                .sort_by_key(|f| format!("{}:{:?}", f.parent_table, f.from_columns));
        }
        m
    };
    let bytes = serde_json::to_vec(&(
        request,
        normalize(&plan.source_metadata),
        normalize(&plan.target_metadata),
        &plan.source.digest,
        &plan.target.digest,
        &plan.target_full.digest,
        &plan.expected.digest,
        &plan.preview.risks,
    ))
    .map_err(|_| "invalid_mapping: 计划指纹编码失败")?;
    hash.update(bytes);
    Ok(format!("{:x}", hash.finalize()))
}
impl StoredDataPlan {
    pub fn read_operation(&self, row: &CanonicalRow) -> Result<Operation, String> {
        let mut op = Operation::from_row(row)?;
        if op.kind == DataDiffOperation::Update {
            if let Some(super::value::DataValue::UInt(index)) = row.key.get(1) {
                op.old = self.target.spool.cursor_at(*index)?.next_row()?;
                if op.old.as_ref().map(|r| r.key_bytes()).transpose()?
                    != op.new.as_ref().map(|r| r.key_bytes()).transpose()?
                {
                    return Err("invalid_mapping: 差异定位失效".into());
                }
            }
        }
        Ok(op)
    }
    pub fn diff_page(
        &self,
        table_id: &str,
        cursor: Option<&str>,
        page_size: u32,
    ) -> Result<DataDiffPage, String> {
        let budget = self.operations.budget();
        let _memory = budget.reserve_memory(budget.memory_bytes / 2)?;
        if page_size == 0 || page_size > 200 {
            return Err("resource_limit: 每页差异数量须在 1 至 200 之间".into());
        }
        let mapping = self
            .mapping
            .tables
            .iter()
            .find(|m| m.target_table == table_id)
            .ok_or("invalid_mapping: 差异表不存在")?;
        let start = cursor
            .map(|s| {
                s.parse::<u64>()
                    .map_err(|_| "invalid_mapping: 差异游标无效")
            })
            .transpose()?
            .unwrap_or(0);
        if start > self.operations.row_count() {
            return Err("invalid_mapping: 差异游标越界".into());
        }
        let mut c = self.operations.cursor_at(start)?;
        let mut position = start;
        let mut items = Vec::new();
        let mut bytes = 0usize;
        while let Some(row) = c.next_row()? {
            position += 1;
            if row.table != table_id {
                continue;
            }
            let op = self.read_operation(&row)?;
            let payload = op
                .new
                .as_ref()
                .or(op.old.as_ref())
                .ok_or("invalid_mapping: 空差异操作")?;
            let mut changes = Vec::new();
            for (i, column) in mapping.target_columns.iter().enumerate() {
                let old = op.old.as_ref().and_then(|r| r.values.get(i));
                let new = op.new.as_ref().and_then(|r| r.values.get(i));
                if old.map(|v| v.canonical_bytes()).transpose()?
                    != new.map(|v| v.canonical_bytes()).transpose()?
                {
                    changes.push(DataColumnDiff {
                        column: column.clone(),
                        old: old.map(value_preview),
                        new: new.map(value_preview),
                    });
                }
            }
            let item = DataDiffItem {
                operation: op.kind,
                key: payload.key.iter().map(value_preview).collect(),
                changes,
            };
            let size = serde_json::to_vec(&item)
                .map_err(|_| "resource_limit: 差异分页编码失败")?
                .len();
            if size > 1024 * 1024 - 4096 {
                return Err("resource_limit: 单行差异字段数超过 IPC 预算".into());
            }
            if !items.is_empty() && bytes + size > 1024 * 1024 - 4096 {
                position -= 1;
                break;
            }
            bytes += size;
            items.push(item);
            if items.len() == page_size as usize {
                break;
            }
        }
        Ok(DataDiffPage {
            plan_id: self.preview.plan_id.clone(),
            table_id: table_id.into(),
            items,
            next_cursor: if position < self.operations.row_count() {
                Some(position.to_string())
            } else {
                None
            },
        })
    }
}
fn value_preview(value: &super::value::DataValue) -> DataValuePreview {
    use super::value::DataValue;
    let (kind, text, len) = match value {
        DataValue::Null => ("null", "NULL".into(), 0),
        DataValue::Bool(v) => ("bool", v.to_string(), 1),
        DataValue::Int(v) => ("int", v.to_string(), 8),
        DataValue::UInt(v) => ("uint", v.to_string(), 8),
        DataValue::Decimal(v) => ("decimal", v.clone(), v.len()),
        DataValue::Float(v) => ("float", f64::from_bits(*v).to_string(), 8),
        DataValue::Text(v) => ("text", v.clone(), v.len()),
        DataValue::Binary(v) => (
            "binary",
            v.iter()
                .take(128)
                .map(|b| format!("{b:02x}"))
                .collect::<String>(),
            v.len(),
        ),
        DataValue::Temporal { kind: _, value } => ("temporal", value.clone(), value.len()),
        DataValue::Uuid(v) => (
            "uuid",
            v.iter().map(|b| format!("{b:02x}")).collect::<String>(),
            16,
        ),
        DataValue::Json(v) => ("json", v.clone(), v.len()),
    };
    let mut end = text.len().min(256);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    DataValuePreview {
        value_type: kind.into(),
        display: text[..end].into(),
        original_bytes: len.to_string(),
        truncated: end < text.len() || (kind == "binary" && len > 128),
    }
}
#[cfg(test)]
mod tests {
    use super::super::{
        metadata::tests::{metadata, request},
        metadata::validate_mapping,
        spool::{ResourceBudget, SpoolWriter},
        value::DataValue,
    };
    use super::*;
    fn row(id: i64, v: &str) -> CanonicalRow {
        CanonicalRow::new(
            "t".into(),
            vec![DataValue::Int(id)],
            vec![DataValue::Int(id), DataValue::Text(v.into())],
        )
        .unwrap()
    }
    fn try_fixture(
        mode: DataTaskMode,
        mut source: Vec<CanonicalRow>,
        mut target: Vec<CanonicalRow>,
    ) -> (Result<StoredDataPlan, String>, std::path::PathBuf) {
        if matches!(mode, DataTaskMode::Append | DataTaskMode::Replace) {
            for row in source.iter_mut().chain(target.iter_mut()) {
                row.key.clear();
            }
        }
        let dir =
            std::env::temp_dir().join(format!("db-connect-plan-test-{}", uuid::Uuid::new_v4()));
        let b = ResourceBudget::default();
        let mut s = SpoolWriter::new(&dir, b.clone()).unwrap();
        s.push_batch(&source).unwrap();
        let mut t = SpoolWriter::new(&dir, b).unwrap();
        t.push_batch(&target).unwrap();
        let s = s.finish().unwrap();
        let t = t.finish().unwrap();
        let m = metadata();
        let r = request(mode);
        let map = validate_mapping(&r, &m, &m).unwrap();
        (
            build_plan("task", r, map, m.clone(), m, s, t.clone(), t),
            dir,
        )
    }
    fn fixture(
        mode: DataTaskMode,
        source: Vec<CanonicalRow>,
        target: Vec<CanonicalRow>,
    ) -> (StoredDataPlan, std::path::PathBuf) {
        let (result, path) = try_fixture(mode, source, target);
        (result.unwrap(), path)
    }
    #[test]
    fn merge_and_mirror_have_exact_counts_and_expected_rows() {
        for mode in [DataTaskMode::Merge, DataTaskMode::Mirror] {
            let (p, d) = fixture(
                mode,
                vec![row(1, "A"), row(2, "B")],
                vec![row(2, "old"), row(3, "C")],
            );
            let c = &p.preview.tables[0].counts;
            assert_eq!(
                (&c.inserted, &c.updated),
                (&"1".to_string(), &"1".to_string())
            );
            assert_eq!(
                c.deleted,
                if mode == DataTaskMode::Mirror {
                    "1"
                } else {
                    "0"
                }
            );
            assert_eq!(
                c.retained,
                if mode == DataTaskMode::Merge {
                    "1"
                } else {
                    "0"
                }
            );
            assert_eq!(
                p.expected.spool.row_count(),
                if mode == DataTaskMode::Merge { 3 } else { 2 }
            );
            let page = p.diff_page("t", None, 1).unwrap();
            assert_eq!(page.items.len(), 1);
            assert!(page.next_cursor.is_some());
            drop(p);
            std::fs::remove_dir_all(d).unwrap();
        }
    }
    #[test]
    fn content_and_mode_protect_fingerprint_but_input_order_does_not() {
        let (a, da) = fixture(DataTaskMode::Merge, vec![row(1, "A"), row(2, "B")], vec![]);
        let (b, db) = fixture(DataTaskMode::Merge, vec![row(2, "B"), row(1, "A")], vec![]);
        let (c, dc) = fixture(
            DataTaskMode::Merge,
            vec![row(1, "changed"), row(2, "B")],
            vec![],
        );
        assert_eq!(a.preview.fingerprint, b.preview.fingerprint);
        assert_ne!(a.preview.fingerprint, c.preview.fingerprint);
        drop((a, b, c));
        for d in [da, db, dc] {
            std::fs::remove_dir_all(d).unwrap();
        }
    }
    #[test]
    fn duplicate_and_null_keys_are_rejected() {
        let (result, d) = try_fixture(DataTaskMode::Merge, vec![row(1, "A"), row(1, "B")], vec![]);
        assert!(result.unwrap_err().contains("定位键重复"));
        std::fs::remove_dir_all(d).unwrap();
        let mut null = row(1, "A");
        null.key[0] = DataValue::Null;
        null.values[0] = DataValue::Null;
        let (result, d) = try_fixture(DataTaskMode::Merge, vec![null], vec![]);
        assert!(result.unwrap_err().contains("定位键为空"));
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn empty_source_mirror_and_transfer_modes_have_exact_risks() {
        let (p, d) = fixture(DataTaskMode::Mirror, vec![], vec![row(1, "A")]);
        assert_eq!(p.preview.tables[0].counts.deleted, "1");
        assert_eq!(p.expected.spool.row_count(), 0);
        assert!(p
            .preview
            .risks
            .iter()
            .any(|r| r.id == "empty_source:t" && r.required));
        drop(p);
        std::fs::remove_dir_all(d).unwrap();
        for mode in [DataTaskMode::Append, DataTaskMode::Replace] {
            let (p, d) = fixture(mode, vec![row(2, "B"), row(2, "B")], vec![row(1, "A")]);
            assert_eq!(p.preview.tables[0].counts.inserted, "2");
            assert_eq!(
                p.expected.spool.row_count(),
                if mode == DataTaskMode::Append { 3 } else { 2 }
            );
            assert_eq!(
                p.preview.tables[0].counts.deleted,
                if mode == DataTaskMode::Replace {
                    "1"
                } else {
                    "0"
                }
            );
            drop(p);
            std::fs::remove_dir_all(d).unwrap();
        }
    }
    #[test]
    fn update_diff_recovers_complete_old_values_and_limits_ipc() {
        let (p, d) = fixture(
            DataTaskMode::Merge,
            vec![row(1, &"新".repeat(4000))],
            vec![row(1, "old")],
        );
        let page = p.diff_page("t", None, 200).unwrap();
        assert_eq!(page.items.len(), 1);
        let change = &page.items[0].changes[0];
        assert_eq!(change.column, "v");
        assert_eq!(change.old.as_ref().unwrap().display, "old");
        assert!(change.new.as_ref().unwrap().truncated);
        assert_eq!(change.new.as_ref().unwrap().original_bytes, "12000");
        assert!(serde_json::to_vec(&page).unwrap().len() < 1024 * 1024);
        assert!(p.diff_page("t", None, 201).is_err());
        assert!(p.diff_page("t", Some("bogus"), 1).is_err());
        drop(p);
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn each_configuration_structure_and_mode_change_invalidates_fingerprint() {
        let (mut p, d) = fixture(DataTaskMode::Merge, vec![row(1, "A")], vec![]);
        let original = p.preview.fingerprint.clone();
        p.target_metadata.configuration_fingerprint = "other-config".into();
        assert_ne!(fingerprint(&p).unwrap(), original);
        p.target_metadata.configuration_fingerprint = "fixture".into();
        p.target_metadata.schema_fingerprint = "other-schema".into();
        assert_ne!(fingerprint(&p).unwrap(), original);
        p.target_metadata.schema_fingerprint = "schema".into();
        p.request.mode = DataTaskMode::Mirror;
        assert_ne!(fingerprint(&p).unwrap(), original);
        drop(p);
        std::fs::remove_dir_all(d).unwrap();
    }
}
