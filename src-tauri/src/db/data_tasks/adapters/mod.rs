pub mod batch;
pub mod sqlite;
pub mod sqlite_async;

use super::spool::{MemoryLease, ResourceBudget};
use super::{
    metadata::{DataMetadataSnapshot, ValidatedTableMapping},
    value::CanonicalRow,
    Cancellation,
};
use std::{future::Future, pin::Pin};
use tokio::sync::mpsc;
pub struct RowEnvelope {
    pub row: CanonicalRow,
    _lease: MemoryLease,
}
pub struct RowSender {
    sender: mpsc::Sender<RowEnvelope>,
    budget: ResourceBudget,
}
impl RowSender {
    pub fn budget(&self) -> ResourceBudget {
        self.budget.clone()
    }
    pub fn channel(budget: ResourceBudget) -> (Self, mpsc::Receiver<RowEnvelope>) {
        let (sender, receiver) = mpsc::channel(1);
        (Self { sender, budget }, receiver)
    }
    pub async fn reserve_decode(&self, bytes: usize) -> Result<MemoryLease, String> {
        if bytes > self.budget.memory_bytes {
            return Err("resource_limit: 单行解码超过共享内存预算".into());
        }
        loop {
            if self.budget.is_cancelled() {
                return Err("cancelled: 数据快照已取消".into());
            }
            if let Ok(lease) = self.budget.reserve_memory(bytes) {
                return Ok(lease);
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
    pub async fn send(&self, row: CanonicalRow) -> Result<(), String> {
        let lease = self.reserve_decode(row.memory_size()).await?;
        self.sender
            .send(RowEnvelope { row, _lease: lease })
            .await
            .map_err(|_| "cancelled: 数据快照通道已关闭".into())
    }
}
pub type SessionFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

/// 一个任务独占一个物理会话。所有读取必须单个集合流，不能在实现中逐表查询。
pub trait DataSession: Send {
    fn supports_transaction(&self) -> bool {
        true
    }
    fn endpoint_identity(&self) -> Option<super::metadata::EndpointIdentity> {
        None
    }
    fn take_cleanup_errors(&mut self) -> Vec<String> {
        Vec::new()
    }
    fn dialect(&self) -> batch::Dialect;
    fn begin_read(&mut self) -> SessionFuture<'_, ()>;
    fn begin_protected_write(&mut self, tables: Vec<String>) -> SessionFuture<'_, ()>;
    fn load_metadata(&mut self) -> SessionFuture<'_, DataMetadataSnapshot>;
    fn stream_rows(
        &mut self,
        projections: Vec<sqlite::Projection>,
        cancel: Cancellation,
        sender: RowSender,
    ) -> SessionFuture<'_, u64>;
    fn write_batch(&mut self, batch: batch::WriteBatch) -> SessionFuture<'_, u64>;
    fn delete_all(&mut self, table: String) -> SessionFuture<'_, u64>;
    fn maintain_generators(&mut self, mapping: Vec<ValidatedTableMapping>)
        -> SessionFuture<'_, ()>;
    fn commit(&mut self) -> SessionFuture<'_, ()>;
    fn rollback(&mut self) -> SessionFuture<'_, ()>;
}

pub mod mysql;

pub mod postgres;
pub mod sqlserver;

pub mod clickhouse;
