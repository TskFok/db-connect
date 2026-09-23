use super::{run_sql_on_client, PostgresCancelHandle, PostgresCancelTls};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod, Runtime};
use serde_json::{json, Value as JsonValue};
use std::collections::{HashSet, VecDeque};
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_postgres::NoTls;

const PROTOCOL_V3: i32 = 196_608;
const CANCEL_REQUEST_CODE: i32 = 80_877_102;
const TEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
struct QueryResponse {
    columns: Vec<String>,
    rows: Vec<Vec<Option<Vec<u8>>>>,
    command_tag: String,
}

impl QueryResponse {
    fn select(columns: &[&str], rows: Vec<Vec<Option<&str>>>) -> Self {
        let row_count = rows.len();
        Self {
            columns: columns.iter().map(|column| (*column).to_string()).collect(),
            rows: rows
                .into_iter()
                .map(|row| {
                    row.into_iter()
                        .map(|value| value.map(|value| value.as_bytes().to_vec()))
                        .collect()
                })
                .collect(),
            command_tag: format!("SELECT {row_count}"),
        }
    }

    fn command(tag: &str) -> Self {
        Self {
            columns: Vec::new(),
            rows: Vec::new(),
            command_tag: tag.to_string(),
        }
    }
}

#[derive(Debug)]
enum QueryPlan {
    Respond(QueryResponse),
    FloodRows { rows: usize },
    OversizedRow { bytes: usize },
    HoldAfterDescription,
    HoldBeforeResponse,
}

#[derive(Debug)]
struct ConnectionPlan {
    queries: VecDeque<QueryPlan>,
}

impl ConnectionPlan {
    fn one(query: QueryPlan) -> Self {
        Self {
            queries: VecDeque::from([query]),
        }
    }

    fn many(queries: impl IntoIterator<Item = QueryPlan>) -> Self {
        Self {
            queries: queries.into_iter().collect(),
        }
    }
}

#[derive(Default)]
struct ServerState {
    plans: Mutex<VecDeque<ConnectionPlan>>,
    sessions: Mutex<HashSet<(i32, i32)>>,
    normal_connections: AtomicUsize,
    cancel_requests: AtomicUsize,
    queries: AtomicUsize,
    closed_connections: AtomicUsize,
    normal_connection_notify: Notify,
    cancel_notify: Notify,
    query_notify: Notify,
    closed_notify: Notify,
}

struct FakePostgresServer {
    addr: SocketAddr,
    state: Arc<ServerState>,
    accept_task: JoinHandle<()>,
}

impl FakePostgresServer {
    async fn start(plans: impl IntoIterator<Item = ConnectionPlan>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake PostgreSQL server");
        let addr = listener.local_addr().expect("fake PostgreSQL address");
        let state = Arc::new(ServerState {
            plans: Mutex::new(plans.into_iter().collect()),
            ..ServerState::default()
        });
        let accept_state = Arc::clone(&state);
        let accept_task = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let connection_state = Arc::clone(&accept_state);
                tokio::spawn(async move {
                    let _ = handle_connection(socket, connection_state).await;
                });
            }
        });
        Self {
            addr,
            state,
            accept_task,
        }
    }

    fn pool(&self) -> Pool {
        let config = format!(
            "host=127.0.0.1 port={} user=test dbname=test sslmode=disable connect_timeout=2",
            self.addr.port()
        )
        .parse::<tokio_postgres::Config>()
        .expect("parse test PostgreSQL config");
        let manager = Manager::from_config(
            config,
            NoTls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        Pool::builder(manager)
            .max_size(1)
            .runtime(Runtime::Tokio1)
            .build()
            .expect("build test pool")
    }

    async fn wait_for_queries(&self, count: usize) {
        wait_for_count(&self.state.queries, &self.state.query_notify, count).await;
    }

    async fn wait_for_closed_connections(&self, count: usize) {
        wait_for_count(
            &self.state.closed_connections,
            &self.state.closed_notify,
            count,
        )
        .await;
    }

    async fn wait_for_normal_connections(&self, count: usize) {
        wait_for_count(
            &self.state.normal_connections,
            &self.state.normal_connection_notify,
            count,
        )
        .await;
    }

    async fn wait_for_cancel_requests(&self, count: usize) {
        wait_for_count(
            &self.state.cancel_requests,
            &self.state.cancel_notify,
            count,
        )
        .await;
    }

    fn normal_connections(&self) -> usize {
        self.state.normal_connections.load(Ordering::SeqCst)
    }

    fn cancel_requests(&self) -> usize {
        self.state.cancel_requests.load(Ordering::SeqCst)
    }
}

impl Drop for FakePostgresServer {
    fn drop(&mut self) {
        self.accept_task.abort();
    }
}

async fn wait_for_count(counter: &AtomicUsize, notify: &Notify, expected: usize) {
    timeout(TEST_TIMEOUT, async {
        loop {
            let notified = notify.notified();
            if counter.load(Ordering::SeqCst) >= expected {
                break;
            }
            notified.await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for counter to reach {expected}"));
}

async fn handle_connection(mut socket: TcpStream, state: Arc<ServerState>) -> io::Result<()> {
    let startup = read_startup_packet(&mut socket).await?;
    let code = i32::from_be_bytes(startup[0..4].try_into().expect("startup code"));
    if code == CANCEL_REQUEST_CODE {
        let process_id = i32::from_be_bytes(startup[4..8].try_into().expect("cancel process id"));
        let secret_key = i32::from_be_bytes(startup[8..12].try_into().expect("cancel secret"));
        assert!(
            state
                .sessions
                .lock()
                .expect("lock sessions")
                .contains(&(process_id, secret_key)),
            "cancel request must target a live fake session"
        );
        state.cancel_requests.fetch_add(1, Ordering::SeqCst);
        state.cancel_notify.notify_waiters();
        return Ok(());
    }
    assert_eq!(code, PROTOCOL_V3, "unexpected startup protocol");

    let connection_number = state.normal_connections.fetch_add(1, Ordering::SeqCst) + 1;
    state.normal_connection_notify.notify_waiters();
    let process_id = 10_000 + connection_number as i32;
    let secret_key = 20_000 + connection_number as i32;
    state
        .sessions
        .lock()
        .expect("lock sessions")
        .insert((process_id, secret_key));
    let plan = state
        .plans
        .lock()
        .expect("lock plans")
        .pop_front()
        .expect("unexpected PostgreSQL connection");

    socket.write_all(&authentication_ok()).await?;
    socket
        .write_all(&parameter_status("server_version", "16.0"))
        .await?;
    socket
        .write_all(&parameter_status("client_encoding", "UTF8"))
        .await?;
    socket
        .write_all(&backend_key_data(process_id, secret_key))
        .await?;
    socket.write_all(&ready_for_query()).await?;
    socket.flush().await?;

    let result = serve_queries(&mut socket, plan, &state).await;
    state.closed_connections.fetch_add(1, Ordering::SeqCst);
    state.closed_notify.notify_waiters();
    result
}

async fn serve_queries(
    socket: &mut TcpStream,
    mut connection_plan: ConnectionPlan,
    state: &ServerState,
) -> io::Result<()> {
    while let Some((tag, payload)) = read_frontend_message(socket).await? {
        if tag == b'X' {
            return Ok(());
        }
        assert!(matches!(tag, b'Q' | b'P'), "expected simple query or Parse");
        assert_eq!(payload.last(), Some(&0), "query must be NUL terminated");
        state.queries.fetch_add(1, Ordering::SeqCst);
        state.query_notify.notify_waiters();
        let query_plan = connection_plan
            .queries
            .pop_front()
            .expect("unexpected query on fake PostgreSQL connection");
        let holds_connection = send_query_plan(socket, query_plan).await?;
        if holds_connection {
            wait_for_client_disconnect(socket).await?;
            return Ok(());
        }
    }
    Ok(())
}

async fn send_query_plan(socket: &mut TcpStream, plan: QueryPlan) -> io::Result<bool> {
    match plan {
        QueryPlan::Respond(response) => {
            if !response.columns.is_empty() {
                socket
                    .write_all(&row_description(&response.columns))
                    .await?;
                for row in &response.rows {
                    socket.write_all(&data_row(row)).await?;
                }
            }
            socket
                .write_all(&command_complete(&response.command_tag))
                .await?;
            socket.write_all(&ready_for_query()).await?;
            socket.flush().await?;
            Ok(false)
        }
        QueryPlan::FloodRows { rows } => {
            let mut response = row_description(&["value".to_string()]);
            let row = data_row(&[Some(b"1".to_vec())]);
            response.reserve(row.len() * rows);
            for _ in 0..rows {
                response.extend_from_slice(&row);
            }
            socket.write_all(&response).await?;
            socket.flush().await?;
            Ok(true)
        }
        QueryPlan::OversizedRow { bytes } => {
            socket
                .write_all(&row_description(&["payload".to_string()]))
                .await?;
            socket
                .write_all(&data_row(&[Some(vec![b'x'; bytes])]))
                .await?;
            socket.flush().await?;
            Ok(true)
        }
        QueryPlan::HoldBeforeResponse => Ok(true),
        QueryPlan::HoldAfterDescription => {
            socket
                .write_all(&row_description(&["waiting".to_string()]))
                .await?;
            socket.flush().await?;
            Ok(true)
        }
    }
}

async fn wait_for_client_disconnect(socket: &mut TcpStream) -> io::Result<()> {
    let mut byte = [0_u8; 1];
    loop {
        match socket.read(&mut byte).await? {
            0 => return Ok(()),
            _ => continue,
        }
    }
}

async fn read_startup_packet(socket: &mut TcpStream) -> io::Result<Vec<u8>> {
    let length = socket.read_i32().await?;
    if length < 8 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "startup packet too short",
        ));
    }
    let mut body = vec![0; length as usize - 4];
    socket.read_exact(&mut body).await?;
    Ok(body)
}

async fn read_frontend_message(socket: &mut TcpStream) -> io::Result<Option<(u8, Vec<u8>)>> {
    let tag = match socket.read_u8().await {
        Ok(tag) => tag,
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    };
    let length = socket.read_i32().await?;
    if length < 4 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frontend message too short",
        ));
    }
    let mut body = vec![0; length as usize - 4];
    socket.read_exact(&mut body).await?;
    Ok(Some((tag, body)))
}

fn frame(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(payload.len() + 5);
    message.push(tag);
    message.extend_from_slice(&((payload.len() + 4) as i32).to_be_bytes());
    message.extend_from_slice(payload);
    message
}

fn authentication_ok() -> Vec<u8> {
    frame(b'R', &0_i32.to_be_bytes())
}

fn parameter_status(name: &str, value: &str) -> Vec<u8> {
    let mut payload = Vec::with_capacity(name.len() + value.len() + 2);
    payload.extend_from_slice(name.as_bytes());
    payload.push(0);
    payload.extend_from_slice(value.as_bytes());
    payload.push(0);
    frame(b'S', &payload)
}

fn backend_key_data(process_id: i32, secret_key: i32) -> Vec<u8> {
    let mut payload = Vec::with_capacity(8);
    payload.extend_from_slice(&process_id.to_be_bytes());
    payload.extend_from_slice(&secret_key.to_be_bytes());
    frame(b'K', &payload)
}

fn ready_for_query() -> Vec<u8> {
    frame(b'Z', b"I")
}

fn row_description(columns: &[String]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&(columns.len() as i16).to_be_bytes());
    for column in columns {
        payload.extend_from_slice(column.as_bytes());
        payload.push(0);
        payload.extend_from_slice(&0_i32.to_be_bytes());
        payload.extend_from_slice(&0_i16.to_be_bytes());
        payload.extend_from_slice(&25_i32.to_be_bytes()); // TEXTOID
        payload.extend_from_slice(&(-1_i16).to_be_bytes());
        payload.extend_from_slice(&(-1_i32).to_be_bytes());
        payload.extend_from_slice(&0_i16.to_be_bytes()); // text format
    }
    frame(b'T', &payload)
}

fn data_row(values: &[Option<Vec<u8>>]) -> Vec<u8> {
    let value_bytes = values
        .iter()
        .filter_map(|value| value.as_ref().map(Vec::len))
        .sum::<usize>();
    let mut payload = Vec::with_capacity(2 + values.len() * 4 + value_bytes);
    payload.extend_from_slice(&(values.len() as i16).to_be_bytes());
    for value in values {
        match value {
            Some(value) => {
                payload.extend_from_slice(&(value.len() as i32).to_be_bytes());
                payload.extend_from_slice(value);
            }
            None => payload.extend_from_slice(&(-1_i32).to_be_bytes()),
        }
    }
    frame(b'D', &payload)
}

fn command_complete(tag: &str) -> Vec<u8> {
    let mut payload = Vec::with_capacity(tag.len() + 1);
    payload.extend_from_slice(tag.as_bytes());
    payload.push(0);
    frame(b'C', &payload)
}

fn cancel_for(client: &deadpool_postgres::Client) -> PostgresCancelHandle {
    PostgresCancelHandle::new(client.cancel_token(), PostgresCancelTls::NoTls)
}

async fn execute(
    pool: &Pool,
    sql: &'static str,
) -> (
    Result<crate::models::types::SqlExecuteResult, String>,
    PostgresCancelHandle,
) {
    let client = timeout(TEST_TIMEOUT, pool.get())
        .await
        .expect("pool checkout timed out")
        .expect("pool checkout failed");
    let cancel = cancel_for(&client);
    let result = timeout(
        TEST_TIMEOUT,
        run_sql_on_client(client, sql, false, Instant::now(), &cancel),
    )
    .await
    .expect("SQL execution timed out");
    (result, cancel)
}

#[tokio::test]
async fn empty_result_keeps_row_description_columns() {
    let server = FakePostgresServer::start([ConnectionPlan::one(QueryPlan::Respond(
        QueryResponse::select(&["id", "note"], Vec::new()),
    ))])
    .await;
    let pool = server.pool();

    let (result, _) = execute(&pool, "SELECT id, note FROM empty_table").await;
    let result = result.expect("empty SELECT should succeed");

    assert_eq!(result.result_type, "select");
    assert_eq!(result.columns, Some(vec!["id".into(), "note".into()]));
    assert_eq!(result.rows, Some(Vec::new()));
    assert_eq!(result.affected_rows, None);
}

#[tokio::test]
async fn rows_preserve_null_and_convert_supported_text_values_to_json() {
    let response = QueryResponse::select(
        &["integer", "float", "boolean_text", "label", "missing"],
        vec![vec![
            Some("42"),
            Some("-3.25"),
            Some("true"),
            Some("hello"),
            None,
        ]],
    );
    let server =
        FakePostgresServer::start([ConnectionPlan::one(QueryPlan::Respond(response))]).await;
    let pool = server.pool();

    let (result, _) = execute(&pool, "SELECT mixed_values").await;
    let result = result.expect("mixed SELECT should succeed");

    assert_eq!(
        result.rows,
        Some(vec![vec![
            json!(42),
            json!(-3.25),
            json!("true"),
            json!("hello"),
            JsonValue::Null,
        ]])
    );
}

#[tokio::test]
async fn dml_uses_command_complete_affected_row_count() {
    let server = FakePostgresServer::start([ConnectionPlan::one(QueryPlan::Respond(
        QueryResponse::command("UPDATE 7"),
    ))])
    .await;
    let pool = server.pool();

    let (result, _) = execute(&pool, "UPDATE widgets SET enabled = false").await;
    let result = result.expect("UPDATE should succeed");

    assert_eq!(result.result_type, "modify");
    assert_eq!(result.columns, None);
    assert_eq!(result.rows, None);
    assert_eq!(result.affected_rows, Some(7));
}

#[tokio::test]
async fn row_limit_returns_before_ready_for_query_and_discards_connection() {
    let server = FakePostgresServer::start([
        ConnectionPlan::one(QueryPlan::FloodRows { rows: 100_001 }),
        ConnectionPlan::one(QueryPlan::Respond(QueryResponse::select(
            &["value"],
            vec![vec![Some("fresh")]],
        ))),
    ])
    .await;
    let pool = server.pool();

    let (result, _) = execute(&pool, "SELECT value FROM too_many_rows").await;
    let error = result.expect_err("100001st row must exceed the result budget");
    assert!(error.contains("最大行数"), "unexpected error: {error}");
    assert!(error.contains("100000"), "unexpected error: {error}");
    server.wait_for_closed_connections(1).await;

    let (fresh, _) = execute(&pool, "SELECT 'fresh' AS value").await;
    assert_eq!(
        fresh.expect("replacement connection should work").rows,
        Some(vec![vec![json!("fresh")]])
    );
    server.wait_for_normal_connections(2).await;
    assert_eq!(server.normal_connections(), 2);
}

#[tokio::test]
async fn byte_limit_reports_exact_budget_and_discards_connection() {
    let server = FakePostgresServer::start([
        ConnectionPlan::one(QueryPlan::OversizedRow {
            bytes: 33 * 1024 * 1024,
        }),
        ConnectionPlan::one(QueryPlan::Respond(QueryResponse::select(
            &["value"],
            vec![vec![Some("fresh")]],
        ))),
    ])
    .await;
    let pool = server.pool();

    let (result, _) = timeout(
        Duration::from_secs(15),
        execute(&pool, "SELECT oversized_payload"),
    )
    .await
    .expect("oversized row test timed out");
    let error = result.expect_err("33 MiB row must exceed the result budget");
    assert!(error.contains("最大字节数"), "unexpected error: {error}");
    assert!(error.contains("33554432"), "unexpected error: {error}");
    server.wait_for_closed_connections(1).await;

    let (fresh, _) = execute(&pool, "SELECT 'fresh' AS value").await;
    assert!(
        fresh.is_ok(),
        "replacement connection should work: {fresh:?}"
    );
    server.wait_for_normal_connections(2).await;
    assert_eq!(server.normal_connections(), 2);
}

#[tokio::test]
async fn cancellation_wakes_stalled_stream_and_discards_connection() {
    let server = FakePostgresServer::start([
        ConnectionPlan::one(QueryPlan::HoldAfterDescription),
        ConnectionPlan::one(QueryPlan::Respond(QueryResponse::select(
            &["value"],
            vec![vec![Some("fresh")]],
        ))),
    ])
    .await;
    let pool = server.pool();
    let client = pool.get().await.expect("pool checkout failed");
    let cancel = cancel_for(&client);
    let runner_cancel = cancel.clone();
    let query_task = tokio::spawn(async move {
        run_sql_on_client(
            client,
            "SELECT pg_sleep(60)",
            false,
            Instant::now(),
            &runner_cancel,
        )
        .await
    });
    server.wait_for_queries(1).await;

    timeout(TEST_TIMEOUT, cancel.clone().cancel())
        .await
        .expect("cancel request timed out")
        .expect("cancel request failed");
    let error = timeout(TEST_TIMEOUT, query_task)
        .await
        .expect("stalled query did not wake after cancellation")
        .expect("query task panicked")
        .expect_err("cancelled query must fail");
    assert!(error.contains("取消"), "unexpected error: {error}");
    server.wait_for_cancel_requests(1).await;
    server.wait_for_closed_connections(1).await;

    let (fresh, _) = execute(&pool, "SELECT 'fresh' AS value").await;
    assert!(
        fresh.is_ok(),
        "replacement connection should work: {fresh:?}"
    );
    server.wait_for_normal_connections(2).await;
    assert_eq!(server.normal_connections(), 2);
}

#[tokio::test]
async fn completed_query_disables_stale_cancel_and_keeps_connection_reusable() {
    let server = FakePostgresServer::start([ConnectionPlan::many([
        QueryPlan::Respond(QueryResponse::select(&["value"], vec![vec![Some("first")]])),
        QueryPlan::Respond(QueryResponse::select(
            &["value"],
            vec![vec![Some("second")]],
        )),
    ])])
    .await;
    let pool = server.pool();

    let (first, stale_cancel) = execute(&pool, "SELECT 'first' AS value").await;
    assert!(first.is_ok());
    stale_cancel
        .cancel()
        .await
        .expect("stale cancellation should be a no-op");
    assert!(
        timeout(
            Duration::from_millis(100),
            server.wait_for_cancel_requests(1)
        )
        .await
        .is_err(),
        "completed query sent a stale CancelRequest"
    );
    assert_eq!(server.cancel_requests(), 0);

    let (second, _) = execute(&pool, "SELECT 'second' AS value").await;
    assert_eq!(
        second.expect("reused connection should work").rows,
        Some(vec![vec![json!("second")]])
    );
    assert_eq!(server.normal_connections(), 1);
}

#[tokio::test]
async fn table_count_cancellation_closes_connection_and_stale_cancel_does_not_reach_next_query() {
    use crate::db::table_query::TableQueryRegistry;

    let server = FakePostgresServer::start([
        ConnectionPlan::one(QueryPlan::HoldBeforeResponse),
        ConnectionPlan::one(QueryPlan::Respond(QueryResponse::select(
            &["value"],
            vec![vec![Some("42")]],
        ))),
    ])
    .await;
    let pool = server.pool();
    let handle = super::PostgresPoolHandle {
        pool: pool.clone(),
        cancel_tls: PostgresCancelTls::NoTls,
    };
    let registry = TableQueryRegistry::default();
    let guard = registry.register("pg", Some("table-count")).unwrap();
    let query = tokio::spawn(async move {
        super::query_table_count(&handle, "public", "large_table", None, &guard.cancellation).await
    });

    server.wait_for_queries(1).await;
    assert!(registry.cancel("pg", "table-count"));
    let result = timeout(TEST_TIMEOUT, query)
        .await
        .expect("COUNT cancellation timed out")
        .unwrap();
    assert!(result.unwrap_err().contains("中断"));
    server.wait_for_cancel_requests(1).await;
    server.wait_for_closed_connections(1).await;
    assert_eq!(
        pool.status().size,
        0,
        "cancelled connection must leave the pool"
    );

    assert!(!registry.cancel("pg", "table-count"));
    let (next, _) = execute(&pool, "SELECT 42 AS value").await;
    assert_eq!(next.unwrap().rows, Some(vec![vec![json!(42)]]));
    assert_eq!(server.normal_connections(), 2);
    assert_eq!(
        server.cancel_requests(),
        1,
        "stale cancellation must not target the new session"
    );
}
