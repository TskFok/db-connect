use futures_util::{future::BoxFuture, FutureExt};
use mysql_async::{prelude::Queryable, Conn, Opts, OptsBuilder};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;

const CANCELLED: &str = "已请求取消查询";
const RETAIN_FOR: Duration = Duration::from_secs(60);
const MAX_RETAINED: usize = 256;
const CANCEL_BUDGET: Duration = Duration::from_secs(2);
const CLOSE_BUDGET: Duration = Duration::from_secs(2);
type QueryKey = (String, String);
type CancelTransport =
    Arc<dyn Fn(Opts, u64) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;

enum Phase {
    Waiting,
    Running { thread_id: u64, opts: Opts },
    Cancelling,
    Finished,
}

struct Control {
    phase: Mutex<Phase>,
    requested: watch::Sender<bool>,
    outcome: watch::Sender<Option<Result<bool, String>>>,
}

impl Control {
    fn new(cancelled: bool) -> Self {
        Self {
            phase: Mutex::new(if cancelled {
                Phase::Cancelling
            } else {
                Phase::Waiting
            }),
            requested: watch::channel(cancelled).0,
            outcome: watch::channel(cancelled.then_some(Ok(true))).0,
        }
    }

    async fn outcome(&self) -> Result<bool, String> {
        let mut receiver = self.outcome.subscribe();
        loop {
            if let Some(result) = receiver.borrow_and_update().clone() {
                return result;
            }
            // Control 持有 sender，等待期间不会关闭。
            receiver
                .changed()
                .await
                .map_err(|_| "取消状态已关闭".to_string())?;
        }
    }
}

enum Entry {
    Active(Arc<Control>),
    Pending(Instant),
    Finished(Instant),
}

#[derive(Clone)]
pub struct MysqlQueryRegistry {
    entries: Arc<Mutex<HashMap<QueryKey, Entry>>>,
    transport: CancelTransport,
    cancel_budget: Duration,
}

impl Default for MysqlQueryRegistry {
    fn default() -> Self {
        Self {
            entries: Arc::default(),
            transport: Arc::new(|opts, thread_id| Box::pin(kill_mysql_query(opts, thread_id))),
            cancel_budget: CANCEL_BUDGET,
        }
    }
}

impl MysqlQueryRegistry {
    pub fn register(&self, conn_id: &str, execution_id: &str) -> Result<MysqlQueryGuard, String> {
        let key = (conn_id.to_string(), execution_id.to_string());
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        Self::prune(&mut entries);
        let cancelled = match entries.get(&key) {
            Some(Entry::Active(_) | Entry::Finished(_)) => {
                return Err("MySQL 查询执行标识已使用".into())
            }
            Some(Entry::Pending(_)) => true,
            None => false,
        };
        let control = Arc::new(Control::new(cancelled));
        entries.insert(key.clone(), Entry::Active(control.clone()));
        Ok(MysqlQueryGuard {
            registry: self.clone(),
            key,
            control,
        })
    }

    /// 早于执行命令到达的取消保留为有界墓碑，避免开始用户 SQL。
    pub async fn cancel(&self, conn_id: &str, execution_id: &str) -> Result<bool, String> {
        let control = {
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            Self::prune(&mut entries);
            let key = (conn_id.to_string(), execution_id.to_string());
            match entries.get(&key) {
                Some(Entry::Active(control)) => control.clone(),
                Some(Entry::Finished(_)) => return Ok(false),
                Some(Entry::Pending(_)) => return Ok(true),
                None => {
                    entries.insert(key, Entry::Pending(Instant::now()));
                    Self::prune(&mut entries);
                    return Ok(true);
                }
            }
        };
        {
            let mut phase = control.phase.lock().unwrap_or_else(|e| e.into_inner());
            match &*phase {
                Phase::Finished => return Ok(false),
                Phase::Cancelling => {}
                Phase::Waiting => {
                    *phase = Phase::Cancelling;
                    control.requested.send_replace(true);
                    control.outcome.send_replace(Some(Ok(true)));
                }
                Phase::Running { thread_id, opts } => {
                    let (thread_id, opts) = (*thread_id, opts.clone());
                    *phase = Phase::Cancelling;
                    control.requested.send_replace(true);
                    let control = control.clone();
                    let transport = self.transport.clone();
                    let budget = self.cancel_budget;
                    // 请求方即使停止等待，取消也必须发布结果；执行方一直持有原连接。
                    tokio::spawn(async move {
                        let io = std::panic::AssertUnwindSafe(async move {
                            transport(opts, thread_id).await
                        })
                        .catch_unwind();
                        let result = match tokio::time::timeout(budget, io).await {
                            Ok(Ok(Ok(()))) => Ok(true),
                            Ok(Ok(Err(error))) => {
                                Err(unconfirmed(format!("取消查询失败: {error}")))
                            }
                            Ok(Err(_)) => Err(unconfirmed("取消任务异常退出".into())),
                            Err(_) => Err(unconfirmed("取消查询超时".into())),
                        };
                        control.outcome.send_replace(Some(result));
                    });
                }
            }
        }
        control.outcome().await
    }

    fn prune(entries: &mut HashMap<QueryKey, Entry>) {
        entries.retain(|_, entry| match entry {
            Entry::Active(_) => true,
            Entry::Pending(at) | Entry::Finished(at) => at.elapsed() < RETAIN_FOR,
        });
        let mut retained: Vec<_> = entries
            .iter()
            .filter_map(|(key, entry)| match entry {
                Entry::Active(_) => None,
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

pub struct MysqlQueryGuard {
    registry: MysqlQueryRegistry,
    key: QueryKey,
    control: Arc<Control>,
}

impl MysqlQueryGuard {
    pub fn attach_connection(&self, thread_id: u64, opts: Opts) -> Result<(), String> {
        let mut phase = self.control.phase.lock().unwrap_or_else(|e| e.into_inner());
        match &*phase {
            Phase::Waiting => {
                // 克隆真实连接的 TLS、认证和隧道端点；辅助连接不重放用户会话 SQL。
                let opts = OptsBuilder::from_opts(opts)
                    .init(Vec::<String>::new())
                    .setup(Vec::<String>::new())
                    .after_connect(|_| Box::pin(async { Ok(()) }));
                *phase = Phase::Running {
                    thread_id,
                    opts: opts.into(),
                };
                Ok(())
            }
            Phase::Cancelling => Err(CANCELLED.into()),
            Phase::Running { .. } => Err("MySQL 查询已绑定连接".into()),
            Phase::Finished => Err("MySQL 查询已完成".into()),
        }
    }

    pub fn is_cancelled(&self) -> bool {
        *self.control.requested.borrow()
    }

    pub async fn run<T>(
        &self,
        future: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let mut requested = self.control.requested.subscribe();
        if self.is_cancelled() {
            return Err(CANCELLED.into());
        }
        tokio::select! {
            biased;
            result = future => match result {
                // 原执行错误优先，不用通用取消信息覆盖数据库错误。
                Err(error) => Err(error),
                Ok(_) if self.is_cancelled() => Err(CANCELLED.into()),
                Ok(value) => Ok(value),
            },
            _ = requested.changed() => Err(CANCELLED.into()),
        }
    }

    /// 完成和取消在同一锁内仲裁；完成先赢后不能再发送 KILL。
    async fn settle(&self) -> Option<Result<bool, String>> {
        {
            let mut phase = self.control.phase.lock().unwrap_or_else(|e| e.into_inner());
            if !matches!(*phase, Phase::Cancelling) {
                *phase = Phase::Finished;
                return None;
            }
        }
        Some(self.control.outcome().await)
    }
}

fn unconfirmed(error: String) -> String {
    format!("{error}；查询是否已终止未确认，请刷新确认执行结果（可能已执行或提交）")
}

/// 总预算由取消任务包围，包括建连、单次 KILL 以及辅助连接关闭。
async fn kill_mysql_query(opts: Opts, thread_id: u64) -> Result<(), String> {
    let mut killer = Conn::new(opts)
        .await
        .map_err(|e| format!("建立取消连接失败: {e}"))?;
    let result = killer
        .query_drop(format!("KILL QUERY {thread_id}"))
        .await
        .map_err(|e| format!("发送 KILL QUERY 失败: {e}"));
    let closed = killer
        .disconnect()
        .await
        .map_err(|e| format!("关闭取消连接失败: {e}"));
    result.and(closed)
}

pub async fn finish_mysql_execution<T>(
    conn: Conn,
    result: Result<T, String>,
    guard: &MysqlQueryGuard,
) -> Result<T, String> {
    finish_connection(conn, result, guard, |conn| async move {
        conn.disconnect_immediately();
        Ok(())
    })
    .await
}

/// 对连接关闭边界注入测试替身，生产和测试共享相同的租约及错误优先级逻辑。
async fn finish_connection<C, T, F: Future<Output = Result<(), String>>>(
    conn: C,
    mut result: Result<T, String>,
    guard: &MysqlQueryGuard,
    close: impl FnOnce(C) -> F,
) -> Result<T, String> {
    let cancelled = guard.settle().await;
    if let Some(outcome) = cancelled {
        result = match (result, outcome) {
            (Err(original), Err(cleanup)) => Err(format!("{original}；{cleanup}")),
            (Ok(_), Err(cleanup)) => Err(cleanup),
            (Err(original), Ok(_)) => Err(original),
            (Ok(_), Ok(_)) => Err(CANCELLED.into()),
        };
    }
    if result.is_err() || guard.is_cancelled() {
        // 生产关闭边界直接丢弃流，绝不为清理而排空尚未读完的结果。
        let closed = match tokio::time::timeout(CLOSE_BUDGET, close(conn)).await {
            Ok(result) => result,
            Err(_) => Err("关闭原查询连接超时".into()),
        };
        if let Err(error) = closed {
            let cleanup = unconfirmed(format!("原连接清理失败: {error}"));
            result = Err(match result {
                Err(original) => format!("{original}；{cleanup}"),
                Ok(_) => cleanup,
            });
        }
    }
    *guard
        .control
        .phase
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Phase::Finished;
    result
}

impl Drop for MysqlQueryGuard {
    fn drop(&mut self) {
        *self.control.phase.lock().unwrap_or_else(|e| e.into_inner()) = Phase::Finished;
        let mut entries = self
            .registry
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if matches!(entries.get(&self.key), Some(Entry::Active(active)) if Arc::ptr_eq(active, &self.control))
        {
            entries.insert(self.key.clone(), Entry::Finished(Instant::now()));
            MysqlQueryRegistry::prune(&mut entries);
        }
    }
}

#[cfg(test)]
#[path = "mysql_query_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "mysql_query_bench_tests.rs"]
mod bench_tests;
