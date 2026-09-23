use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;

const CANCELLED: &str = "表数据加载已中断";
const RETAIN_FOR: Duration = Duration::from_secs(60);
const MAX_RETAINED: usize = 256;
type QueryKey = (String, String);

#[derive(Clone)]
pub struct TableQueryCancellation {
    requested: watch::Sender<bool>,
}

impl Default for TableQueryCancellation {
    fn default() -> Self {
        Self {
            requested: watch::channel(false).0,
        }
    }
}

impl TableQueryCancellation {
    pub fn is_cancelled(&self) -> bool {
        *self.requested.borrow()
    }
    pub fn check(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }
    pub(crate) fn cancel(&self) {
        self.requested.send_replace(true);
    }
    pub async fn run<T>(
        &self,
        future: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let mut requested = self.requested.subscribe();
        self.check()?;
        tokio::select! {
            biased;
            _ = requested.changed() => Err(CANCELLED.into()),
            result = future => { self.check()?; result }
        }
    }
}

enum Entry {
    Running(TableQueryCancellation),
    Pending(Instant),
    Finished(Instant),
}

#[derive(Clone, Default)]
pub struct TableQueryRegistry {
    entries: Arc<Mutex<HashMap<QueryKey, Entry>>>,
}

impl TableQueryRegistry {
    pub fn register(
        &self,
        connection: &str,
        execution: Option<&str>,
    ) -> Result<TableQueryGuard, String> {
        let cancellation = TableQueryCancellation::default();
        let key = execution.map(|execution| (connection.to_string(), execution.to_string()));
        if let Some(key) = &key {
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            Self::prune(&mut entries);
            match entries.get(key) {
                Some(Entry::Running(_) | Entry::Finished(_)) => {
                    return Err("表查询执行标识已使用".into())
                }
                Some(Entry::Pending(_)) => cancellation.cancel(),
                None => {}
            }
            entries.insert(key.clone(), Entry::Running(cancellation.clone()));
        }
        Ok(TableQueryGuard {
            cancellation,
            key,
            registry: self.clone(),
        })
    }

    /// 未登记的取消短暂保留，覆盖 IPC 取消命令先于查询命令执行的竞态。
    pub fn cancel(&self, connection: &str, execution: &str) -> bool {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        Self::prune(&mut entries);
        let key = (connection.to_string(), execution.to_string());
        match entries.get(&key) {
            Some(Entry::Running(token)) => token.cancel(),
            Some(Entry::Finished(_)) => return false,
            Some(Entry::Pending(_)) => {}
            None => {
                entries.insert(key, Entry::Pending(Instant::now()));
            }
        }
        Self::prune(&mut entries);
        true
    }

    fn prune(entries: &mut HashMap<QueryKey, Entry>) {
        entries.retain(|_, entry| match entry {
            Entry::Running(_) => true,
            Entry::Pending(at) | Entry::Finished(at) => at.elapsed() < RETAIN_FOR,
        });
        let mut retained: Vec<_> = entries
            .iter()
            .filter_map(|(key, entry)| match entry {
                Entry::Running(_) => None,
                Entry::Pending(at) | Entry::Finished(at) => Some((key.clone(), *at)),
            })
            .collect();
        if retained.len() > MAX_RETAINED {
            retained.sort_unstable_by_key(|(_, at)| *at);
            let excess = retained.len() - MAX_RETAINED;
            for (key, _) in retained.into_iter().take(excess) {
                entries.remove(&key);
            }
        }
    }
}

pub struct TableQueryGuard {
    pub cancellation: TableQueryCancellation,
    key: Option<QueryKey>,
    registry: TableQueryRegistry,
}

impl Drop for TableQueryGuard {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            let mut entries = self
                .registry
                .entries
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            entries.insert(key, Entry::Finished(Instant::now()));
            TableQueryRegistry::prune(&mut entries);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::Duration;

    #[tokio::test]
    async fn cancellation_before_registration_prevents_starting_work() {
        let registry = TableQueryRegistry::default();
        registry.cancel("connection", "execution");
        let guard = registry.register("connection", Some("execution")).unwrap();
        let started = Arc::new(AtomicBool::new(false));
        let result = guard
            .cancellation
            .run(async {
                started.store(true, Ordering::SeqCst);
                Ok(())
            })
            .await;
        assert!(result.is_err());
        assert!(!started.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn cancellation_drops_work_waiting_for_a_connection() {
        let registry = TableQueryRegistry::default();
        let guard = registry.register("connection", Some("execution")).unwrap();
        let wait = guard
            .cancellation
            .run(std::future::pending::<Result<(), String>>());
        let cancel = async {
            tokio::task::yield_now().await;
            registry.cancel("connection", "execution");
        };
        let result = tokio::time::timeout(Duration::from_millis(100), async {
            tokio::join!(wait, cancel).0
        })
        .await;
        assert!(matches!(result, Ok(Err(_))));
    }

    #[test]
    fn cancellation_is_scoped_to_connection_and_execution() {
        let registry = TableQueryRegistry::default();
        let first = registry.register("a", Some("same")).unwrap();
        let other_connection = registry.register("b", Some("same")).unwrap();
        let other_execution = registry.register("a", Some("next")).unwrap();
        assert!(registry.cancel("a", "same"));
        assert!(first.cancellation.is_cancelled());
        assert!(!other_connection.cancellation.is_cancelled());
        assert!(!other_execution.cancellation.is_cancelled());
    }

    #[test]
    fn finished_execution_cannot_cancel_a_later_query() {
        let registry = TableQueryRegistry::default();
        drop(registry.register("connection", Some("old")).unwrap());
        let newer = registry.register("connection", Some("new")).unwrap();
        assert!(!registry.cancel("connection", "old"));
        assert!(!newer.cancellation.is_cancelled());
        assert!(registry.register("connection", Some("old")).is_err());
    }

    #[test]
    fn duplicate_running_execution_is_rejected() {
        let registry = TableQueryRegistry::default();
        let _guard = registry.register("connection", Some("execution")).unwrap();
        assert!(registry.register("connection", Some("execution")).is_err());
    }
}
