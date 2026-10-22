//! 跨类型任务使用的 SQLite 专属线程会话。rusqlite 不在 Tokio 工作线程执行。
use super::{
    batch::{Dialect, WriteBatch},
    sqlite::{self, Projection},
    DataSession, RowSender, SessionFuture,
};
use crate::{
    db::{
        data_tasks::{
            metadata::{DataMetadataSnapshot, EndpointIdentity, ValidatedTableMapping},
            Cancellation,
        },
        sql_utils::sqlite_id,
    },
    models::{
        data_tasks::DataEndpoint,
        types::{ConnectionConfig, DatabaseType},
    },
};
use std::{path::PathBuf, sync::atomic::Ordering};

type Job = Box<dyn FnOnce(&mut Worker) + Send>;
struct Worker {
    connection: rusqlite::Connection,
    config: ConnectionConfig,
    writable: bool,
}
pub struct SqliteAsyncSession {
    jobs: tokio::sync::mpsc::Sender<Job>,
    identity: EndpointIdentity,
    cancel: Cancellation,
}
impl SqliteAsyncSession {
    pub async fn open(
        config: ConnectionConfig,
        endpoint: DataEndpoint,
        cancel: Cancellation,
    ) -> Result<Box<dyn DataSession>, String> {
        if config.database_type != DatabaseType::Sqlite || endpoint.database != "main" {
            return Err("unsupported_capability: SQLite 只支持 main 数据库".into());
        }
        let path = PathBuf::from(
            config
                .sqlite_path
                .as_ref()
                .ok_or("invalid_mapping: SQLite 文件配置不存在")?,
        );
        let canonical =
            std::fs::canonicalize(&path).map_err(|_| "invalid_mapping: SQLite 文件不可访问")?;
        let writable = !config.read_only.unwrap_or(false)
            && !std::fs::metadata(&canonical)
                .map_err(|_| "无法读取 SQLite 文件权限")?
                .permissions()
                .readonly();
        let identity = EndpointIdentity {
            database_type: DatabaseType::Sqlite,
            instance: None,
            database: "main".into(),
            sqlite_path: Some(canonical.clone()),
        };
        let (jobs, mut receiver) = tokio::sync::mpsc::channel::<Job>(1);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let worker_cancel = cancel.clone();
        std::thread::Builder::new()
            .name("data-task-sqlite".into())
            .spawn(move || {
                let connection = match sqlite::open(&canonical, writable, worker_cancel) {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                let mut worker = Worker {
                    connection,
                    config,
                    writable,
                };
                let _ = ready_tx.send(Ok(()));
                while let Some(job) = receiver.blocking_recv() {
                    job(&mut worker);
                }
            })
            .map_err(|_| "resource_limit: 无法建立 SQLite 专属线程")?;
        ready_rx.await.map_err(|_| "SQLite 专属线程中断")??;
        Ok(Box::new(Self {
            jobs,
            identity,
            cancel,
        }))
    }
    async fn call<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Worker) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.jobs
            .send(Box::new(move |worker| {
                let _ = sender.send(operation(worker));
            }))
            .await
            .map_err(|_| "SQLite 专属会话已关闭")?;
        receiver.await.map_err(|_| "SQLite 专属线程中断")?
    }
}
impl DataSession for SqliteAsyncSession {
    fn endpoint_identity(&self) -> Option<EndpointIdentity> {
        Some(self.identity.clone())
    }
    fn dialect(&self) -> Dialect {
        Dialect::Sqlite
    }
    fn begin_read(&mut self) -> SessionFuture<'_, ()> {
        Box::pin(self.call(|worker| {
            worker
                .connection
                .execute_batch("BEGIN DEFERRED")
                .map_err(|_| "无法建立 SQLite 读取事务".into())
        }))
    }
    fn begin_protected_write(&mut self, tables: Vec<String>) -> SessionFuture<'_, ()> {
        Box::pin(self.call(move |worker| {
            if tables.is_empty() || tables.len() > 100 {
                return Err("invalid_mapping: SQLite 目标范围无效".into());
            }
            if !worker.writable {
                return Err("read_only_target: SQLite 目标文件或连接只读".into());
            }
            worker
                .connection
                .execute_batch("BEGIN IMMEDIATE")
                .map_err(|_| "lock_timeout: 无法在 10 秒内锁定 SQLite 目标".into())
        }))
    }
    fn load_metadata(&mut self) -> SessionFuture<'_, DataMetadataSnapshot> {
        Box::pin(self.call(|worker| {
            let metadata = sqlite::load_metadata(&worker.connection)?;
            Ok(DataMetadataSnapshot {
                database_type: DatabaseType::Sqlite,
                tables: metadata.tables,
                read_only: !worker.writable,
                permissions_verified: true,
                consistent_snapshot: true,
                protected_write: worker.writable,
                schema_fingerprint: metadata.signature,
                configuration_fingerprint:
                    crate::db::data_tasks::executor::configuration_fingerprint(&worker.config),
            })
        }))
    }
    fn stream_rows(
        &mut self,
        projections: Vec<Projection>,
        cancel: Cancellation,
        sender: RowSender,
    ) -> SessionFuture<'_, u64> {
        let runtime = tokio::runtime::Handle::current();
        Box::pin(self.call(move |worker| {
            sqlite::stream_rows(&worker.connection, &projections, &cancel, |row| {
                runtime.block_on(sender.send(row))
            })
        }))
    }
    fn write_batch(&mut self, batch: WriteBatch) -> SessionFuture<'_, u64> {
        let cancel = self.cancel.clone();
        Box::pin(self.call(move |worker| {
            if cancel.load(Ordering::Acquire) {
                return Err("cancelled: 数据任务已取消".into());
            }
            let values = batch
                .params
                .iter()
                .map(sqlite::bind_value)
                .collect::<Result<Vec<_>, _>>()?;
            worker
                .connection
                .execute(&batch.sql, rusqlite::params_from_iter(values))
                .map(|count| count as u64)
                .map_err(|_| "constraint_conflict: SQLite 批量写入约束或权限校验失败".into())
        }))
    }
    fn delete_all(&mut self, table: String) -> SessionFuture<'_, u64> {
        let cancel = self.cancel.clone();
        Box::pin(self.call(move |worker| {
            if cancel.load(Ordering::Acquire) {
                return Err("cancelled: 数据任务已取消".into());
            }
            worker
                .connection
                .execute(&format!("DELETE FROM main.{}", sqlite_id(&table)), [])
                .map(|count| count as u64)
                .map_err(|_| "constraint_conflict: SQLite 目标删除失败".into())
        }))
    }
    fn maintain_generators(
        &mut self,
        _mapping: Vec<ValidatedTableMapping>,
    ) -> SessionFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
    fn commit(&mut self) -> SessionFuture<'_, ()> {
        Box::pin(self.call(|worker| {
            worker
                .connection
                .execute_batch("COMMIT")
                .map_err(|_| "SQLite 提交响应未确认".into())
        }))
    }
    fn rollback(&mut self) -> SessionFuture<'_, ()> {
        Box::pin(self.call(|worker| {
            worker
                .connection
                .progress_handler(0, None::<fn() -> bool>)
                .map_err(|_| "无法关闭 SQLite 取消回调")?;
            worker
                .connection
                .execute_batch("ROLLBACK")
                .map_err(|_| "SQLite 回滚响应未确认".into())
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::data_tasks::{spool::ResourceBudget, value::DataValue};
    use std::sync::{atomic::AtomicBool, Arc};
    #[tokio::test]
    async fn actor_reads_native_values_and_rolls_back_on_same_physical_session() {
        let directory =
            std::env::temp_dir().join(format!("db-connect-sqlite-actor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("test.sqlite");
        rusqlite::Connection::open(&path).unwrap().execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY,v BLOB);INSERT INTO t VALUES(9007199254740993,X'00FF');").unwrap();
        let config:ConnectionConfig=serde_json::from_value(serde_json::json!({"id":"sqlite","database_type":"sqlite","name":"fixture","host":"","port":0,"username":"","sqlite_path":path})).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let mut session = SqliteAsyncSession::open(
            config,
            DataEndpoint {
                saved_connection_id: "sqlite".into(),
                database: "main".into(),
            },
            cancel.clone(),
        )
        .await
        .unwrap();
        session
            .begin_protected_write(vec!["t".into()])
            .await
            .unwrap();
        assert_eq!(session.load_metadata().await.unwrap().tables.len(), 1);
        assert_eq!(session.delete_all("t".into()).await.unwrap(), 1);
        session.rollback().await.unwrap();
        session.begin_read().await.unwrap();
        let (sender, mut receiver) =
            RowSender::channel(ResourceBudget::with_cancellation(cancel.clone()));
        let reader = session.stream_rows(
            vec![Projection {
                table: "t".into(),
                output_table: "t".into(),
                columns: vec!["id".into(), "v".into()],
                key_indices: vec![0],
            }],
            cancel,
            sender,
        );
        let consumer = async move {
            let row = receiver.recv().await.unwrap().row;
            assert_eq!(
                row.values,
                vec![
                    DataValue::Int(9007199254740993),
                    DataValue::Binary(vec![0, 255])
                ]
            );
        };
        let (read, ()) = tokio::join!(reader, consumer);
        assert_eq!(read.unwrap(), 1);
        session.rollback().await.unwrap();
        drop(session);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
