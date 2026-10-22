#[cfg(test)]
mod acceptance_network_tests;
#[cfg(test)]
mod acceptance_tests;
pub mod adapters;
#[cfg(test)]
mod cross_type_tests;
pub mod executor;
pub mod history;
#[cfg(test)]
mod integration_tests;
pub mod registry;
pub mod value;

use crate::models::data_tasks::DataTaskStatus;
use std::sync::{atomic::AtomicBool, Arc};

pub type Cancellation = Arc<AtomicBool>;
pub type ProgressCallback = Arc<dyn Fn(ProgressUpdate) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct ProgressUpdate {
    pub status: DataTaskStatus,
    pub read_rows: u64,
    pub written_rows: u64,
    pub verified_rows: u64,
    pub bytes: u64,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub mod metadata;
pub mod plan;
pub mod spool;
pub mod type_mapping;
