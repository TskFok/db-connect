//! 每行一个认证加密块；游标只持有当前块，排序使用有界初始段与二路归并。
use super::value::{decode_row, CanonicalRow};
use crate::util::secure_fs::{create_secure_file, set_secure_dir_permissions};
use aes_gcm::{aead::AeadInPlace, Aes256Gcm, KeyInit, Nonce};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
const ERROR: &str = "resource_limit: 加密快照读写失败或认证无效";
#[derive(Clone, Debug)]
pub struct ResourceBudget {
    pub max_row_bytes: usize,
    pub memory_bytes: usize,
    pub sort_run_bytes: usize,
    pub disk_bytes: u64,
    used: Arc<AtomicU64>,
    cancelled: Arc<AtomicBool>,
    memory_used: Arc<AtomicU64>,
    disk_peak: Arc<AtomicU64>,
    memory_peak: Arc<AtomicU64>,
}
impl Default for ResourceBudget {
    fn default() -> Self {
        Self {
            max_row_bytes: 8 * 1024 * 1024,
            memory_bytes: 64 * 1024 * 1024,
            sort_run_bytes: 16 * 1024 * 1024,
            disk_bytes: 5 * 1024 * 1024 * 1024,
            used: Arc::new(AtomicU64::new(0)),
            cancelled: Arc::new(AtomicBool::new(false)),
            memory_used: Arc::new(AtomicU64::new(0)),
            disk_peak: Arc::new(AtomicU64::new(0)),
            memory_peak: Arc::new(AtomicU64::new(0)),
        }
    }
}
pub struct MemoryLease {
    used: Arc<AtomicU64>,
    bytes: u64,
}
impl Drop for MemoryLease {
    fn drop(&mut self) {
        self.used.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
impl ResourceBudget {
    #[cfg(test)]
    pub fn disk_peak(&self) -> u64 {
        self.disk_peak.load(Ordering::Acquire)
    }
    #[cfg(test)]
    pub fn memory_peak(&self) -> u64 {
        self.memory_peak.load(Ordering::Acquire)
    }
    pub fn reserve_memory(&self, bytes: usize) -> Result<MemoryLease, String> {
        self.check()?;
        let bytes = bytes as u64;
        let previous = self
            .memory_used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |v| {
                v.checked_add(bytes)
                    .filter(|n| *n <= self.memory_bytes as u64)
            })
            .map_err(|_| "resource_limit: 数据任务超过共享内存预算")?;
        self.memory_peak
            .fetch_max(previous + bytes, Ordering::AcqRel);
        Ok(MemoryLease {
            used: self.memory_used.clone(),
            bytes,
        })
    }
    #[cfg(test)]
    pub fn memory_used(&self) -> u64 {
        self.memory_used.load(Ordering::Acquire)
    }
    pub fn with_cancellation(cancelled: Arc<AtomicBool>) -> Self {
        Self {
            cancelled,
            ..Self::default()
        }
    }
    #[cfg(test)]
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    #[cfg(test)]
    pub fn disk_used(&self) -> u64 {
        self.used.load(Ordering::Acquire)
    }
    fn check(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err("cancelled: 数据快照已取消".into())
        } else {
            Ok(())
        }
    }
    fn reserve(&self, n: u64) -> Result<(), String> {
        self.check()?;
        self.used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |v| {
                v.checked_add(n).filter(|n| *n <= self.disk_bytes)
            })
            .map(|previous| {
                self.disk_peak.fetch_max(previous + n, Ordering::AcqRel);
            })
            .map_err(|_| "resource_limit: 临时数据超过磁盘配额".into())
    }
}
struct Inner {
    path: PathBuf,
    index_path: PathBuf,
    dir: PathBuf,
    key: [u8; 32],
    prefix: [u8; 4],
    budget: ResourceBudget,
    bytes: u64,
    data_bytes: u64,
    rows: u64,
    captured_at_ms: u64,
}
impl Drop for Inner {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(&self.index_path);
        self.budget.used.fetch_sub(self.bytes, Ordering::AcqRel);
        self.key.fill(0);
    }
}
pub struct SpoolWriter {
    file: File,
    index_file: File,
    inner: Inner,
    failed: bool,
}
#[derive(Clone)]
pub struct SpoolHandle(Arc<Inner>);
impl std::fmt::Debug for SpoolHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpoolHandle")
            .field("rows", &self.0.rows)
            .finish_non_exhaustive()
    }
}
pub struct SpoolCursor {
    handle: SpoolHandle,
    file: File,
    index: u64,
}
#[derive(Clone, Debug)]
pub struct SortedSpool {
    pub spool: SpoolHandle,
    pub digest: String,
}
impl SpoolWriter {
    pub fn new(dir: &Path, budget: ResourceBudget) -> Result<Self, String> {
        budget.check()?;
        if budget.memory_bytes < 1024 || budget.max_row_bytes == 0 || budget.sort_run_bytes == 0 {
            return Err("resource_limit: 无效的内存预算".into());
        }
        std::fs::create_dir_all(dir).map_err(|_| ERROR)?;
        set_secure_dir_permissions(dir).map_err(|_| ERROR)?;
        let path = dir.join(format!("{}.spool", uuid::Uuid::new_v4()));
        let file = create_secure_file(&path).map_err(|_| ERROR)?;
        let index_path = path.with_extension("index");
        let index_file = match create_secure_file(&index_path) {
            Ok(f) => f,
            Err(_) => {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return Err(ERROR.into());
            }
        };
        let mut key = [0; 32];
        let mut prefix = [0; 4];
        OsRng.fill_bytes(&mut key);
        OsRng.fill_bytes(&mut prefix);
        Ok(Self {
            inner: Inner {
                path,
                index_path,
                dir: dir.to_path_buf(),
                key,
                prefix,
                budget,
                bytes: 0,
                data_bytes: 0,
                rows: 0,
                captured_at_ms: 0,
            },
            file,
            index_file,
            failed: false,
        })
    }
    pub fn push_batch(&mut self, rows: &[CanonicalRow]) -> Result<(), String> {
        for row in rows {
            self.push(row)?;
        }
        Ok(())
    }
    fn push(&mut self, row: &CanonicalRow) -> Result<(), String> {
        if self.failed {
            return Err(ERROR.into());
        }
        let result = self.push_inner(row);
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn push_inner(&mut self, row: &CanonicalRow) -> Result<(), String> {
        self.inner.budget.check()?;
        if row.memory_size() > self.inner.budget.memory_bytes / 4
            || row.encoded_size() > self.inner.budget.max_row_bytes
            || row.encoded_size().saturating_mul(4) > self.inner.budget.memory_bytes
        {
            return Err("resource_limit: 单行超过快照或内存预算".into());
        }
        let _memory = self
            .inner
            .budget
            .reserve_memory(row.encoded_size().saturating_mul(2))?;
        let mut bytes = row.canonical_bytes()?;
        if bytes.len() > self.inner.budget.max_row_bytes
            || bytes.len().saturating_mul(4) > self.inner.budget.memory_bytes
        {
            return Err("resource_limit: 单行超过快照或内存预算".into());
        }
        let mut nonce = [0; 12];
        nonce[..4].copy_from_slice(&self.inner.prefix);
        nonce[4..].copy_from_slice(&self.inner.rows.to_be_bytes());
        let length = (bytes.len() + 16) as u64;
        let mut aad = [0; 16];
        aad[..8].copy_from_slice(&self.inner.rows.to_be_bytes());
        aad[8..].copy_from_slice(&length.to_be_bytes());
        Aes256Gcm::new_from_slice(&self.inner.key)
            .map_err(|_| ERROR)?
            .encrypt_in_place(Nonce::from_slice(&nonce), &aad, &mut bytes)
            .map_err(|_| ERROR)?;
        let mut offset = self.inner.data_bytes.to_be_bytes().to_vec();
        let mut index_nonce = nonce;
        index_nonce[0] ^= 0x80;
        Aes256Gcm::new_from_slice(&self.inner.key)
            .map_err(|_| ERROR)?
            .encrypt_in_place(
                Nonce::from_slice(&index_nonce),
                &self.inner.rows.to_be_bytes(),
                &mut offset,
            )
            .map_err(|_| ERROR)?;
        let size = length + 8 + 24;
        self.inner.budget.reserve(size)?;
        self.inner.bytes += size;
        self.file
            .write_all(&length.to_be_bytes())
            .and_then(|_| self.file.write_all(&bytes))
            .map_err(|_| ERROR)?;
        self.index_file.write_all(&offset).map_err(|_| ERROR)?;
        self.inner.data_bytes += length + 8;
        self.inner.rows = self.inner.rows.checked_add(1).ok_or(ERROR)?;
        Ok(())
    }
    pub fn finish(mut self) -> Result<SpoolHandle, String> {
        if self.failed {
            return Err(ERROR.into());
        }
        self.inner.budget.check()?;
        self.index_file.flush().map_err(|_| ERROR)?;
        self.file.flush().map_err(|_| ERROR)?;
        self.inner.captured_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Ok(SpoolHandle(Arc::new(self.inner)))
    }
}
impl SpoolHandle {
    pub fn cursor(&self) -> Result<SpoolCursor, String> {
        self.0.budget.check()?;
        let file = File::open(&self.0.path).map_err(|_| ERROR)?;
        if file.metadata().map_err(|_| ERROR)?.len() != self.0.data_bytes {
            return Err(ERROR.into());
        }
        Ok(SpoolCursor {
            handle: self.clone(),
            file,
            index: 0,
        })
    }
    #[cfg(test)]
    pub fn read_page(&self, offset: u64, limit: usize) -> Result<Vec<CanonicalRow>, String> {
        if limit > 200 {
            return Err("resource_limit: 快照分页最多 200 行".into());
        }
        let _memory = self
            .0
            .budget
            .reserve_memory(self.0.budget.memory_bytes / 4)?;
        let mut cursor = self.cursor_at(offset.min(self.0.rows))?;
        let mut output = Vec::new();
        let mut memory = 0;
        for i in offset..offset.saturating_add(limit as u64) {
            match cursor.next_row()? {
                Some(row) if i >= offset => {
                    memory += row
                        .memory_size()
                        .saturating_add(std::mem::size_of::<CanonicalRow>());
                    if memory > self.0.budget.memory_bytes / 4 {
                        return Err("resource_limit: 快照分页超过内存预算".into());
                    }
                    output.push(row);
                }
                Some(_) => {}
                None => break,
            }
        }
        Ok(output)
    }
    pub fn cursor_at(&self, index: u64) -> Result<SpoolCursor, String> {
        if index > self.0.rows {
            return Err("resource_limit: 快照游标越界".into());
        }
        let mut cursor = self.cursor()?;
        if index == self.0.rows {
            cursor.index = index;
            return Ok(cursor);
        }
        let mut file = File::open(&self.0.index_path).map_err(|_| ERROR)?;
        if file.metadata().map_err(|_| ERROR)?.len() != self.0.rows * 24 {
            return Err(ERROR.into());
        }
        file.seek(SeekFrom::Start(index * 24)).map_err(|_| ERROR)?;
        let mut offset = vec![0; 24];
        file.read_exact(&mut offset).map_err(|_| ERROR)?;
        let mut nonce = [0; 12];
        nonce[..4].copy_from_slice(&self.0.prefix);
        nonce[0] ^= 0x80;
        nonce[4..].copy_from_slice(&index.to_be_bytes());
        Aes256Gcm::new_from_slice(&self.0.key)
            .map_err(|_| ERROR)?
            .decrypt_in_place(Nonce::from_slice(&nonce), &index.to_be_bytes(), &mut offset)
            .map_err(|_| ERROR)?;
        let offset = u64::from_be_bytes(offset.as_slice().try_into().map_err(|_| ERROR)?);
        if offset >= self.0.data_bytes {
            return Err(ERROR.into());
        }
        cursor
            .file
            .seek(SeekFrom::Start(offset))
            .map_err(|_| ERROR)?;
        cursor.index = index;
        Ok(cursor)
    }
    pub(crate) fn writer_with_overhead(&self, extra: usize) -> Result<SpoolWriter, String> {
        let mut budget = self.budget();
        budget.max_row_bytes = budget.max_row_bytes.checked_add(extra).ok_or(ERROR)?;
        SpoolWriter::new(&self.0.dir, budget)
    }
    pub fn captured_at_ms(&self) -> u64 {
        self.0.captured_at_ms
    }
    pub fn row_count(&self) -> u64 {
        self.0.rows
    }
    pub fn byte_count(&self) -> u64 {
        self.0.bytes
    }
    pub fn budget(&self) -> ResourceBudget {
        self.0.budget.clone()
    }
    pub fn writer(&self) -> Result<SpoolWriter, String> {
        SpoolWriter::new(&self.0.dir, self.0.budget.clone())
    }
}
impl SpoolCursor {
    pub fn next_row(&mut self) -> Result<Option<CanonicalRow>, String> {
        self.handle.0.budget.check()?;
        if self.index == self.handle.0.rows {
            return Ok(None);
        }
        let mut len = [0; 8];
        self.file.read_exact(&mut len).map_err(|_| ERROR)?;
        let len = u64::from_be_bytes(len);
        if len < 16 || len > self.handle.0.budget.max_row_bytes as u64 + 16 {
            return Err(ERROR.into());
        }
        let _memory = self
            .handle
            .0
            .budget
            .reserve_memory((len as usize).saturating_mul(2))?;
        let mut bytes = vec![0; len as usize];
        self.file.read_exact(&mut bytes).map_err(|_| ERROR)?;
        let mut nonce = [0; 12];
        nonce[..4].copy_from_slice(&self.handle.0.prefix);
        nonce[4..].copy_from_slice(&self.index.to_be_bytes());
        let mut aad = [0; 16];
        aad[..8].copy_from_slice(&self.index.to_be_bytes());
        aad[8..].copy_from_slice(&len.to_be_bytes());
        Aes256Gcm::new_from_slice(&self.handle.0.key)
            .map_err(|_| ERROR)?
            .decrypt_in_place(Nonce::from_slice(&nonce), &aad, &mut bytes)
            .map_err(|_| ERROR)?;
        self.index += 1;
        decode_row(&bytes).map(Some)
    }
}
fn compare(a: &CanonicalRow, b: &CanonicalRow) -> std::cmp::Ordering {
    a.key_bytes()
        .expect("validated row")
        .cmp(&b.key_bytes().expect("validated row"))
        .then_with(|| {
            a.canonical_bytes()
                .expect("validated row")
                .cmp(&b.canonical_bytes().expect("validated row"))
        })
}
fn merge(a: &SpoolHandle, b: &SpoolHandle) -> Result<SpoolHandle, String> {
    let mut ca = a.cursor()?;
    let mut cb = b.cursor()?;
    let mut ra = ca.next_row()?;
    let mut rb = cb.next_row()?;
    let mut w = a.writer()?;
    while ra.is_some() || rb.is_some() {
        let take_a = match (&ra, &rb) {
            (Some(a), Some(b)) => compare(a, b).is_le(),
            (Some(_), None) => true,
            _ => false,
        };
        if take_a {
            w.push(ra.as_ref().unwrap())?;
            ra = ca.next_row()?;
        } else {
            w.push(rb.as_ref().unwrap())?;
            rb = cb.next_row()?;
        }
    }
    w.finish()
}
/// 初始段最多 sort_run_bytes，归并扇入固定为 2，文件均共享同一硬配额。
pub fn external_sort(s: &SpoolHandle) -> Result<SortedSpool, String> {
    let _memory = s.0.budget.reserve_memory(s.0.budget.memory_bytes / 2)?;
    let mut cursor = s.cursor()?;
    let mut levels: Vec<Option<SpoolHandle>> = Vec::new();
    let mut pending = None;
    loop {
        let mut rows = Vec::new();
        let mut size = 0;
        loop {
            let row = if let Some(r) = pending.take() {
                Some(r)
            } else {
                cursor.next_row()?
            };
            match row {
                Some(row) => {
                    let n = row
                        .memory_size()
                        .saturating_add(std::mem::size_of::<CanonicalRow>());
                    if !rows.is_empty()
                        && size + n > s.0.budget.sort_run_bytes.min(s.0.budget.memory_bytes / 2)
                    {
                        pending = Some(row);
                        break;
                    }
                    size += n;
                    rows.push(row);
                }
                None => break,
            }
        }
        if rows.is_empty() {
            break;
        }
        rows.sort_unstable_by(compare);
        let mut w = s.writer()?;
        for row in &rows {
            w.push(row)?;
        }
        drop(rows);
        let mut run = w.finish()?;
        let mut level = 0;
        loop {
            if level == levels.len() {
                levels.push(Some(run));
                break;
            }
            match levels[level].take() {
                Some(other) => {
                    run = merge(&other, &run)?;
                    level += 1;
                }
                None => {
                    levels[level] = Some(run);
                    break;
                }
            }
        }
    }
    let mut merged = None;
    for run in levels.into_iter().flatten() {
        merged = Some(match merged {
            Some(other) => merge(&other, &run)?,
            None => run,
        });
    }
    let mut spool = match merged {
        Some(s) => s,
        None => s.writer()?.finish()?,
    };
    if let Some(inner) = Arc::get_mut(&mut spool.0) {
        inner.captured_at_ms = s.0.captured_at_ms;
    }
    let mut hash = Sha256::new();
    let mut c = spool.cursor()?;
    while let Some(row) = c.next_row()? {
        let bytes = row.canonical_bytes()?;
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
    }
    Ok(SortedSpool {
        spool,
        digest: format!("{:x}", hash.finalize()),
    })
}
#[cfg(test)]
mod tests {
    use super::super::value::DataValue;
    use super::*;
    fn dir() -> std::path::PathBuf {
        let p =
            std::env::temp_dir().join(format!("db-connect-spool-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&p).unwrap();
        p
    }
    fn row(id: i64) -> CanonicalRow {
        CanonicalRow::new(
            "t".into(),
            vec![DataValue::Int(id)],
            vec![DataValue::Int(id), DataValue::Text("秘密".into())],
        )
        .unwrap()
    }
    #[test]
    fn encrypted_spool_roundtrips_and_paginates() {
        let d = dir();
        let mut w = SpoolWriter::new(&d, ResourceBudget::default()).unwrap();
        w.push_batch(&[row(3), row(1), row(2)]).unwrap();
        let h = w.finish().unwrap();
        assert_eq!(h.read_page(1, 1).unwrap(), vec![row(1)]);
        let sorted = external_sort(&h).unwrap();
        assert_eq!(
            sorted.spool.read_page(0, 10).unwrap(),
            vec![row(1), row(2), row(3)]
        );
        drop(sorted);
        drop(h);
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 0);
        std::fs::remove_dir(d).unwrap();
    }
    #[test]
    fn oversized_rows_and_shared_quota_never_truncate() {
        let d = dir();
        let b = ResourceBudget {
            max_row_bytes: 40,
            ..ResourceBudget::default()
        };
        let mut w = SpoolWriter::new(&d, b).unwrap();
        assert!(w.push_batch(&[row(1)]).is_err());
        let b = ResourceBudget {
            disk_bytes: 160,
            ..ResourceBudget::default()
        };
        let mut w = SpoolWriter::new(&d, b.clone()).unwrap();
        let a = w.push_batch(&[row(1)]);
        assert!(a.is_ok());
        let mut other = SpoolWriter::new(&d, b).unwrap();
        assert!(other.push_batch(&[row(2)]).is_err());
        drop(w);
        drop(other);
        std::fs::remove_dir_all(d).unwrap();
    }
}
#[cfg(test)]
mod boundary_tests {
    use super::super::value::DataValue;
    use super::*;
    fn dir() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "db-connect-spool-boundary-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&p).unwrap();
        p
    }
    fn row(v: i64) -> CanonicalRow {
        CanonicalRow::new(
            "t".into(),
            vec![DataValue::Int(v)],
            vec![DataValue::Int(v), DataValue::Text("private-value".into())],
        )
        .unwrap()
    }
    #[test]
    fn authentication_rejects_tamper_reordering_and_truncation() {
        let d = dir();
        let mut w = SpoolWriter::new(&d, ResourceBudget::default()).unwrap();
        w.push_batch(&[row(1), row(1)]).unwrap();
        let h = w.finish().unwrap();
        let original = std::fs::read(&h.0.path).unwrap();
        let len = u64::from_be_bytes(original[..8].try_into().unwrap()) as usize;
        assert_ne!(&original[8..8 + len], &original[16 + len..16 + 2 * len]);
        assert!(!original.windows(13).any(|v| v == b"private-value"));
        let mut tampered = original.clone();
        tampered[12] ^= 1;
        std::fs::write(&h.0.path, &tampered).unwrap();
        assert!(h.read_page(0, 1).is_err());
        let mut swapped = original.clone();
        swapped[8..8 + len].copy_from_slice(&original[16 + len..16 + 2 * len]);
        std::fs::write(&h.0.path, &swapped).unwrap();
        assert!(h.read_page(0, 1).is_err());
        std::fs::write(&h.0.path, &original[..original.len() - 1]).unwrap();
        assert!(h.cursor().is_err());
        drop(h);
        std::fs::remove_dir(d).unwrap();
    }
    #[test]
    fn encrypted_index_seeks_and_authenticates_row_positions() {
        let d = dir();
        let mut w = SpoolWriter::new(&d, ResourceBudget::default()).unwrap();
        for i in 0..500 {
            w.push_batch(&[row(i)]).unwrap();
        }
        let h = w.finish().unwrap();
        assert_eq!(h.read_page(498, 2).unwrap(), vec![row(498), row(499)]);
        let mut index = std::fs::read(&h.0.index_path).unwrap();
        index[498 * 24] ^= 1;
        std::fs::write(&h.0.index_path, index).unwrap();
        assert!(h.read_page(498, 1).is_err());
        drop(h);
        std::fs::remove_dir(d).unwrap();
    }
    #[test]
    fn cancellation_and_failed_write_clean_up_and_never_finish_partial_spool() {
        let d = dir();
        let b = ResourceBudget::default();
        let mut w = SpoolWriter::new(&d, b.clone()).unwrap();
        w.push_batch(&[row(1)]).unwrap();
        b.cancel();
        assert!(w.push_batch(&[row(2)]).is_err());
        assert!(w.finish().is_err());
        assert_eq!(b.disk_used(), 0);
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 0);
        let mut w = SpoolWriter::new(&d, ResourceBudget::default()).unwrap();
        w.file = File::open(&w.inner.path).unwrap();
        assert!(w.push_batch(&[row(1)]).is_err());
        assert!(w.finish().is_err());
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 0);
        std::fs::remove_dir(d).unwrap();
    }
    #[test]
    fn exact_eight_mib_boundary_and_memory_limits_are_enforced() {
        let d = dir();
        let b = ResourceBudget::default();
        let mut r = row(1);
        r.values[1] = DataValue::Text(String::new());
        let overhead = r.encoded_size();
        r.values[1] = DataValue::Text("x".repeat(b.max_row_bytes - overhead));
        let mut w = SpoolWriter::new(&d, b.clone()).unwrap();
        w.push_batch(std::slice::from_ref(&r)).unwrap();
        let h = w.finish().unwrap();
        assert_eq!(h.read_page(0, 1).unwrap()[0], r);
        let mut over = r.clone();
        if let DataValue::Text(v) = &mut over.values[1] {
            v.push('x');
        }
        let mut w = h.writer().unwrap();
        assert!(w.push_batch(&[over]).is_err());
        drop(w);
        drop(h);
        drop(r);
        let b = ResourceBudget {
            memory_bytes: 64,
            ..ResourceBudget::default()
        };
        assert!(SpoolWriter::new(&d, b).is_err());
        std::fs::remove_dir(d).unwrap();
    }
    #[test]
    fn external_sort_multiple_passes_preserves_multiset_and_counts_intermediates() {
        let d = dir();
        let b = ResourceBudget {
            sort_run_bytes: 256,
            ..ResourceBudget::default()
        };
        let mut w = SpoolWriter::new(&d, b.clone()).unwrap();
        for i in (0..160).rev() {
            w.push_batch(&[row(i % 80)]).unwrap();
        }
        let h = w.finish().unwrap();
        let original_bytes = b.disk_used();
        let sorted = external_sort(&h).unwrap();
        assert_eq!(sorted.spool.row_count(), 160);
        let mut c = sorted.spool.cursor().unwrap();
        for i in 0..80 {
            assert_eq!(c.next_row().unwrap(), Some(row(i)));
            assert_eq!(c.next_row().unwrap(), Some(row(i)));
        }
        assert_eq!(c.next_row().unwrap(), None);
        drop(c);
        assert!(b.disk_used() > original_bytes);
        drop(sorted);
        assert_eq!(b.disk_used(), original_bytes);
        drop(h);
        assert_eq!(b.disk_used(), 0);
        std::fs::remove_dir(d).unwrap();
    }
}

#[cfg(test)]
mod memory_tests {
    use super::*;
    #[test]
    fn concurrent_consumers_share_one_memory_budget() {
        let budget = ResourceBudget {
            memory_bytes: 1024,
            ..ResourceBudget::default()
        };
        let other = budget.clone();
        let lease = budget.reserve_memory(700).unwrap();
        assert_eq!(other.memory_used(), 700);
        assert!(other.reserve_memory(400).is_err());
        drop(lease);
        assert_eq!(budget.memory_used(), 0);
        assert!(other.reserve_memory(1024).is_ok());
    }
}
#[cfg(test)]
mod heap_budget_tests {
    use super::super::value::DataValue;
    use super::*;
    #[test]
    fn wide_null_rows_count_decoded_heap_in_memory_budget() {
        let d = std::env::temp_dir().join(format!("db-connect-wide-{}", uuid::Uuid::new_v4()));
        let b = ResourceBudget {
            memory_bytes: 64 * 1024,
            ..ResourceBudget::default()
        };
        let mut w = SpoolWriter::new(&d, b).unwrap();
        let row = CanonicalRow::new("t".into(), vec![], vec![DataValue::Null; 1000]).unwrap();
        assert!(w.push_batch(&[row]).is_err());
        drop(w);
        std::fs::remove_dir(d).unwrap();
    }
}

#[cfg(test)]
mod peak_tests {
    use super::*;
    #[test]
    fn released_resources_retain_exact_shared_peak() {
        let d = std::env::temp_dir().join(format!("db-connect-peak-{}", uuid::Uuid::new_v4()));
        let b = ResourceBudget::default();
        let a = b.reserve_memory(200).unwrap();
        let c = b.reserve_memory(300).unwrap();
        assert_eq!(b.memory_peak(), 500);
        drop((a, c));
        assert_eq!(b.memory_used(), 0);
        let mut w = SpoolWriter::new(&d, b.clone()).unwrap();
        w.push_batch(&[CanonicalRow::new("t".into(), vec![], vec![]).unwrap()])
            .unwrap();
        let peak = b.disk_used();
        assert!(peak > 0);
        assert_eq!(b.disk_peak(), peak);
        drop(w);
        assert_eq!(b.disk_used(), 0);
        assert_eq!(b.disk_peak(), peak);
        std::fs::remove_dir(d).unwrap();
    }
}
