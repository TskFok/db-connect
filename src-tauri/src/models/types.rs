use serde::{Deserialize, Serialize};
use std::fmt;

/// 日志 / Debug 输出中的密码占位符
pub const PASSWORD_REDACTED: &str = "••••••••";

fn redact_secret(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .filter(|p| !p.is_empty() && *p != PASSWORD_REDACTED)
        .map(|_| PASSWORD_REDACTED.to_string())
}

/// 将连接配置中的密码字段替换为占位符（列表展示、日志输出）
pub fn redact_connection_secrets(config: &mut ConnectionConfig) {
    if redact_secret(&config.password).is_some() {
        config.password = Some(PASSWORD_REDACTED.to_string());
    }
    if let Some(ref mut ssh) = config.ssh {
        if redact_secret(&ssh.password).is_some() {
            ssh.password = Some(PASSWORD_REDACTED.to_string());
        }
    }
    if redact_secret(&config.ssl_pkcs12_password).is_some() {
        config.ssl_pkcs12_password = Some(PASSWORD_REDACTED.to_string());
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseType {
    #[default]
    MySql,
    Postgres,
    Sqlite,
    SqlServer,
    ClickHouse,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseCompareEndpointRequest {
    pub saved_connection_id: String,
    pub database: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CompareEndpointInfo {
    pub connection_id: String,
    pub connection_name: String,
    pub database: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ColumnSnapshot {
    pub ordinal_position: u32,
    pub column_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub primary_key: bool,
    pub extra: String,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SchemaDiffStatus {
    SourceOnly,
    TargetOnly,
    Changed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ColumnDiff {
    pub name: String,
    pub status: SchemaDiffStatus,
    pub changed_fields: Vec<String>,
    pub source: Option<ColumnSnapshot>,
    pub target: Option<ColumnSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TableDiff {
    pub name: String,
    pub status: SchemaDiffStatus,
    pub columns: Vec<ColumnDiff>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct DatabaseCompareSummary {
    pub source_only_tables: usize,
    pub target_only_tables: usize,
    pub changed_tables: usize,
    pub different_columns: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseCompareResult {
    pub database_type: DatabaseType,
    pub source: CompareEndpointInfo,
    pub target: CompareEndpointInfo,
    pub compared_at: String,
    pub summary: DatabaseCompareSummary,
    pub tables: Vec<TableDiff>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseSyncRequest {
    pub source: DatabaseCompareEndpointRequest,
    pub target: DatabaseCompareEndpointRequest,
    pub selected_tables: Vec<String>,
    pub include_drops: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseSyncRisk {
    Normal,
    High,
    Destructive,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseSyncOperationKind {
    CreateTable,
    AddColumn,
    AlterColumn,
    ReplacePrimaryKey,
    DropColumn,
    DropTable,
    UpdateComment,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseSyncOperation {
    pub id: String,
    pub table_name: String,
    pub kind: DatabaseSyncOperationKind,
    pub summary: String,
    pub risk: DatabaseSyncRisk,
    pub sql: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseSyncSkippedItem {
    pub table_name: String,
    pub summary: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseSyncBlocker {
    pub table_name: String,
    pub summary: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct DatabaseSyncPlanSummary {
    pub selected_tables: usize,
    pub executable_operations: usize,
    pub high_risk_operations: usize,
    pub destructive_operations: usize,
    pub skipped_items: usize,
    pub blockers: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseSyncPreview {
    pub plan_fingerprint: String,
    pub summary: DatabaseSyncPlanSummary,
    pub operations: Vec<DatabaseSyncOperation>,
    pub skipped_items: Vec<DatabaseSyncSkippedItem>,
    pub blockers: Vec<DatabaseSyncBlocker>,
    pub can_execute: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecuteDatabaseSyncRequest {
    pub request: DatabaseSyncRequest,
    pub plan_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseSyncStatementSuccess {
    pub operation_id: String,
    pub statement_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseSyncFailure {
    pub operation_id: String,
    pub statement_index: usize,
    pub error: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseSyncExecutionStatus {
    Succeeded,
    PartiallySucceeded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseSyncExecutionResult {
    pub status: DatabaseSyncExecutionStatus,
    pub completed_statements: Vec<DatabaseSyncStatementSuccess>,
    pub failed: Option<DatabaseSyncFailure>,
    pub pending_operation_ids: Vec<String>,
    pub cleanup_errors: Vec<String>,
    pub latest_compare_result: Option<DatabaseCompareResult>,
}

/// 数据库连接配置
#[derive(Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    /// 唯一标识 (保存时自动生成)
    pub id: Option<String>,
    /// 数据库类型；旧配置缺省时等同 MySQL
    #[serde(default)]
    pub database_type: DatabaseType,
    /// 连接名称
    pub name: String,
    /// 数据库主机地址
    pub host: String,
    /// 数据库端口
    pub port: u16,
    /// 数据库用户名
    pub username: String,
    /// 数据库密码 (可选)
    pub password: Option<String>,
    /// 默认数据库 (可选)
    pub database: Option<String>,
    /// SQLite 数据库文件路径
    #[serde(default)]
    pub sqlite_path: Option<String>,
    /// SSH 隧道配置 (None 表示直连)
    pub ssh: Option<SshConfig>,
    /// SSL 模式: `disabled` / `required` / `verify_ca` / `verify_identity` / `required_insecure`（可选，缺省等同 disabled）
    #[serde(default)]
    pub ssl_mode: Option<String>,
    /// PEM 格式的 CA 证书路径（verify_ca / verify_identity 必填）
    #[serde(default)]
    pub ssl_ca_path: Option<String>,
    /// PKCS#12 客户端证书路径（可选，双向 TLS）
    #[serde(default)]
    pub ssl_pkcs12_path: Option<String>,
    /// PKCS#12 归档密码（可选）
    #[serde(default)]
    pub ssl_pkcs12_password: Option<String>,
    /// TLS 校验时使用的主机名（经隧道连接时可填目标 MySQL 主机名）
    #[serde(default)]
    pub ssl_tls_hostname: Option<String>,
    /// 客户端字符集（`SET NAMES`，默认 utf8mb4）；仅允许字母数字、`_`、`-`
    #[serde(default)]
    pub client_charset: Option<String>,
    /// 连接建立后依次执行的会话级 SQL（如 `SET SESSION max_execution_time = 30000`）
    #[serde(default)]
    pub session_init_commands: Option<Vec<String>>,
    /// 只读连接：仅允许查询类 SQL 编辑器语句及 UI 中的读操作，禁止 DML/DDL 等写操作
    #[serde(default)]
    pub read_only: Option<bool>,
    /// 为 true 时跳过 SQL 编辑器对 TRUNCATE / DROP DATABASE 等的高危二次确认（不推荐）
    #[serde(default)]
    pub skip_dangerous_sql_confirm: Option<bool>,
    /// 所属连接分组；None 表示未分组
    #[serde(default)]
    pub group_id: Option<String>,
}

/// 连接分组
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectionGroup {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub collapsed: bool,
}

/// SSH 隧道配置
#[derive(Clone, Serialize, Deserialize)]
pub struct SshConfig {
    /// SSH 服务器地址
    pub host: String,
    /// SSH 服务器端口
    pub port: u16,
    /// SSH 用户名
    pub username: String,
    /// SSH 密码 (密码认证)
    pub password: Option<String>,
    /// SSH 私钥路径 (密钥认证)
    pub private_key_path: Option<String>,
}

impl fmt::Debug for SshConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SshConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field(
                "password",
                &self.password.as_ref().map(|_| PASSWORD_REDACTED),
            )
            .field("private_key_path", &self.private_key_path)
            .finish()
    }
}

impl fmt::Debug for ConnectionConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnectionConfig")
            .field("id", &self.id)
            .field("database_type", &self.database_type)
            .field("name", &self.name)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field(
                "password",
                &self.password.as_ref().map(|_| PASSWORD_REDACTED),
            )
            .field("database", &self.database)
            .field("sqlite_path", &self.sqlite_path)
            .field("ssh", &self.ssh)
            .field("ssl_mode", &self.ssl_mode)
            .field("ssl_ca_path", &self.ssl_ca_path)
            .field("ssl_pkcs12_path", &self.ssl_pkcs12_path)
            .field(
                "ssl_pkcs12_password",
                &self.ssl_pkcs12_password.as_ref().map(|_| PASSWORD_REDACTED),
            )
            .field("ssl_tls_hostname", &self.ssl_tls_hostname)
            .field("client_charset", &self.client_charset)
            .field("session_init_commands", &self.session_init_commands)
            .field("read_only", &self.read_only)
            .field(
                "skip_dangerous_sql_confirm",
                &self.skip_dangerous_sql_confirm,
            )
            .field("group_id", &self.group_id)
            .finish()
    }
}

/// 连接测试结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestResult {
    pub success: bool,
    pub message: String,
    /// 连接耗时 (毫秒)
    pub latency_ms: u64,
}

/// 数据库信息 (字符集/排序规则)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseInfo {
    /// 数据库名称
    pub name: String,
    /// 默认字符集
    pub character_set: String,
    /// 默认排序规则
    pub collation: String,
}

/// 表信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    /// 表名
    pub name: String,
    /// 类型: "TABLE" 或 "VIEW"
    pub table_type: String,
    /// 存储引擎 (视图为 None)
    pub engine: Option<String>,
    /// 预估行数
    pub rows: Option<u64>,
    /// 数据大小 (字节)
    pub data_length: Option<u64>,
    /// 索引大小 (字节)
    pub index_length: Option<u64>,
    /// 表注释
    pub comment: String,
}

/// 列信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    /// 列名
    pub name: String,
    /// 数据类型 (例如 varchar(255), int, bigint unsigned)
    pub column_type: String,
    /// 是否允许 NULL
    pub nullable: bool,
    /// 键类型: "PRI", "UNI", "MUL", 或空字符串
    pub key: String,
    /// 默认值
    pub default_value: Option<String>,
    /// 额外信息 (例如 auto_increment)
    pub extra: String,
    /// 列注释
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlCompletionTable {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlCompletionColumn {
    pub table: String,
    pub name: String,
    #[serde(rename = "type")]
    pub data_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlCompletionMetadata {
    pub databases: Vec<String>,
    pub tables: Vec<SqlCompletionTable>,
    pub columns: Vec<SqlCompletionColumn>,
}

/// 索引信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexInfo {
    /// 索引名称
    pub name: String,
    /// 是否唯一索引
    pub unique: bool,
    /// 索引类型: "BTREE", "HASH", "FULLTEXT", "SPATIAL"
    pub index_type: String,
    /// 索引关联的列列表 (有序)
    pub columns: Vec<IndexColumnInfo>,
    /// 是否为主键
    pub is_primary: bool,
    /// 索引注释
    pub comment: String,
}

/// 索引中的列信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexColumnInfo {
    /// 列名
    pub column_name: String,
    /// 在索引中的顺序 (从 1 开始)
    pub seq_in_index: u32,
    /// 排序方式: "A" (ASC), "D" (DESC), 或 None
    pub collation: Option<String>,
    /// 子部分 (前缀长度, 例如 varchar 的前 10 个字符)
    pub sub_part: Option<u64>,
}

/// 创建索引的请求参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateIndexRequest {
    /// 索引名称
    pub index_name: String,
    /// 索引类型: "INDEX", "UNIQUE", "FULLTEXT", "SPATIAL"
    pub index_type: String,
    /// 索引方法: "BTREE" 或 "HASH" (可选)
    pub index_method: Option<String>,
    /// 要索引的列 (列名, 可选前缀长度)
    pub columns: Vec<CreateIndexColumn>,
    /// 索引注释 (可选)
    pub comment: Option<String>,
}

/// 创建索引时的列定义
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateIndexColumn {
    /// 列名
    pub column_name: String,
    /// 前缀长度 (可选, 用于 varchar 等类型)
    pub length: Option<u32>,
    /// 排序方式: "ASC" 或 "DESC"
    pub order: Option<String>,
}

/// 触发器信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerInfo {
    /// 触发器名称
    pub name: String,
    /// 事件: "INSERT", "UPDATE", "DELETE"
    pub event: String,
    /// 时机: "BEFORE" 或 "AFTER"
    pub timing: String,
    /// 关联的表名
    pub table_name: String,
    /// 触发器语句体
    pub statement: String,
    /// 创建时间
    pub created: Option<String>,
    /// SQL 模式
    pub sql_mode: String,
    /// 定义者
    pub definer: String,
}

/// 外键信息（相对当前选中表的 outgoing / incoming）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKeyInfo {
    pub constraint_name: String,
    /// "outgoing"：当前表为子表；"incoming"：其它表引用当前表为父表
    pub direction: String,
    pub table_schema: String,
    pub table_name: String,
    pub column_names: Vec<String>,
    pub referenced_table_schema: String,
    pub referenced_table_name: String,
    pub referenced_column_names: Vec<String>,
    pub update_rule: String,
    pub delete_rule: String,
}

/// 通过向导添加外键的请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddForeignKeyRequest {
    pub constraint_name: String,
    pub columns: Vec<String>,
    /// 被引用表，可为 `table` 或 `schema.table`
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}

/// 存储过程 / 函数摘要
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutineInfo {
    pub name: String,
    /// "PROCEDURE" 或 "FUNCTION"
    pub routine_type: String,
    pub data_type: Option<String>,
    pub definer: String,
    pub security_type: String,
    pub routine_comment: String,
    pub created: Option<String>,
    pub last_altered: Option<String>,
    pub identity_arguments: Option<String>,
}

/// 定时事件（SHOW EVENTS 一行）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventInfo {
    pub name: String,
    pub definer: String,
    pub time_zone: String,
    pub event_type: String,
    pub execute_at: Option<String>,
    pub interval_value: Option<String>,
    pub interval_field: Option<String>,
    pub starts: Option<String>,
    pub ends: Option<String>,
    pub status: String,
    pub originator: Option<String>,
    pub character_set_client: String,
    pub collation_connection: String,
    pub database_collation: String,
}

/// 创建触发器的请求参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTriggerRequest {
    /// 触发器名称
    pub name: String,
    /// 时机: "BEFORE" 或 "AFTER"
    pub timing: String,
    /// 事件: "INSERT", "UPDATE", "DELETE"
    pub event: String,
    /// 触发器语句体 (BEGIN ... END 之间的内容或单条语句)
    pub body: String,
}

/// 修改列时调整物理顺序（FIRST / AFTER）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AlterColumnPlacement {
    First,
    After { column: String },
}

/// 修改列的请求参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlterColumnRequest {
    /// 原列名 (用于 CHANGE COLUMN)
    pub old_name: String,
    /// 新列名
    pub new_name: String,
    /// 数据类型 (如 varchar(255))
    pub column_type: String,
    /// 是否允许 NULL
    pub nullable: bool,
    /// 默认值
    pub default_value: Option<String>,
    /// 额外属性 (如 auto_increment)
    pub extra: String,
    /// 列注释
    pub comment: String,
    /// 是否为主键（None = 不变更主键状态）
    #[serde(default)]
    pub is_primary: Option<bool>,
    /// 列顺序（None = 不改变位置）
    #[serde(default)]
    pub column_placement: Option<AlterColumnPlacement>,
}

/// 新增列的请求参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddColumnRequest {
    /// 列名
    pub name: String,
    /// 数据类型 (如 varchar(255))
    pub column_type: String,
    /// 是否允许 NULL
    pub nullable: bool,
    /// 默认值
    pub default_value: Option<String>,
    /// 额外属性 (如 auto_increment)
    pub extra: String,
    /// 列注释
    pub comment: String,
    /// 在哪个列之后 (None = 末尾)
    pub after_column: Option<String>,
}

/// 新建表时的列定义
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTableColumnDef {
    /// 列名
    pub name: String,
    /// 数据类型 (如 varchar(255))
    pub column_type: String,
    /// 是否允许 NULL
    pub nullable: bool,
    /// 默认值
    pub default_value: Option<String>,
    /// 额外属性 (如 auto_increment)
    pub extra: String,
    /// 列注释
    pub comment: String,
}

/// 新建表的请求参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTableRequest {
    /// 表名
    pub table_name: String,
    /// 列定义列表
    pub columns: Vec<CreateTableColumnDef>,
    /// 主键列名列表
    pub primary_keys: Vec<String>,
    /// 存储引擎 (如 InnoDB)
    pub engine: String,
    /// ClickHouse 排序键列名列表；空或缺省时使用 ORDER BY tuple()
    #[serde(default)]
    pub order_by: Option<Vec<String>>,
    /// 表注释
    pub comment: String,
}

/// 表数据查询结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    /// 列名列表
    pub columns: Vec<String>,
    /// 行数据 (每行是一个值数组, 与 columns 对应)
    pub rows: Vec<Vec<serde_json::Value>>,
    /// 满足条件的总行数 (用于分页)
    pub total: u64,
    /// 查询耗时 (毫秒)
    pub execution_time_ms: u64,
}

/// 当前连接会话信息（便于排障）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub version: String,
    pub hostname: String,
    /// 实例是否只读（@@read_only）
    pub server_read_only: bool,
    /// MySQL：`max_execution_time`（毫秒）；MariaDB：`max_statement_time`（秒）换算的近似毫秒
    pub max_execution_time_ms: u64,
    pub time_zone: String,
    pub database: Option<String>,
    pub connection_id: u64,
    /// 根据 `SHOW GRANTS FOR CURRENT_USER()`：当前账号是否具有 DML/DDL/管理等写类权限（仅 SELECT/USAGE 等为 false）
    pub grant_write_capable: bool,
}

/// SQL 执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlExecuteResult {
    /// 结果类型: "select", "modify", "error"
    pub result_type: String,
    /// 列名 (仅 SELECT 时有值)
    pub columns: Option<Vec<String>>,
    /// 行数据 (仅 SELECT 时有值)
    pub rows: Option<Vec<Vec<serde_json::Value>>>,
    /// 影响行数 (仅 INSERT/UPDATE/DELETE 时有值)
    pub affected_rows: Option<u64>,
    /// 提示消息
    pub message: String,
    /// 执行耗时 (毫秒)
    pub execution_time_ms: u64,
}

/// 单条导入失败的记录（1-based 语句序号）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportSqlStatementFailure {
    pub statement_index: u32,
    pub statement_preview: String,
    pub error: String,
}

/// 从文件批量执行 SQL 的结果（失败条目不中断后续语句）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportSqlFileResult {
    pub statements_total: u32,
    pub statements_ok: u32,
    pub statements_failed: u32,
    /// 失败详情（条数可能有上限，见后端 MAX_RECORDED_IMPORT_FAILURES）
    pub failures: Vec<ImportSqlStatementFailure>,
    pub elapsed_ms: u64,
}

/// 导出数据库为 .sql 文件的结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportSqlFileResult {
    pub tables_exported: u32,
    pub views_exported: u32,
    pub triggers_exported: u32,
    pub events_exported: u32,
    pub insert_rows: u64,
    pub file_path: String,
    pub elapsed_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_database_info_serialization() {
        let db_info = DatabaseInfo {
            name: "myapp".to_string(),
            character_set: "utf8mb4".to_string(),
            collation: "utf8mb4_general_ci".to_string(),
        };

        let json = serde_json::to_string(&db_info).unwrap();
        let deserialized: DatabaseInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.name, "myapp");
        assert_eq!(deserialized.character_set, "utf8mb4");
        assert_eq!(deserialized.collation, "utf8mb4_general_ci");
    }

    #[test]
    fn test_table_info_serialization() {
        let table = TableInfo {
            name: "users".to_string(),
            table_type: "TABLE".to_string(),
            engine: Some("InnoDB".to_string()),
            rows: Some(1000),
            data_length: Some(65536),
            index_length: Some(16384),
            comment: "用户表".to_string(),
        };

        let json = serde_json::to_string(&table).unwrap();
        let deserialized: TableInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.name, "users");
        assert_eq!(deserialized.table_type, "TABLE");
        assert_eq!(deserialized.engine, Some("InnoDB".to_string()));
    }

    #[test]
    fn test_column_info_serialization() {
        let column = ColumnInfo {
            name: "id".to_string(),
            column_type: "bigint unsigned".to_string(),
            nullable: false,
            key: "PRI".to_string(),
            default_value: None,
            extra: "auto_increment".to_string(),
            comment: "主键".to_string(),
        };

        let json = serde_json::to_string(&column).unwrap();
        let deserialized: ColumnInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.name, "id");
        assert!(!deserialized.nullable);
        assert_eq!(deserialized.key, "PRI");
        assert_eq!(deserialized.extra, "auto_increment");
    }

    #[test]
    fn test_view_table_info() {
        let view = TableInfo {
            name: "active_users".to_string(),
            table_type: "VIEW".to_string(),
            engine: None,
            rows: None,
            data_length: None,
            index_length: None,
            comment: "".to_string(),
        };

        let json = serde_json::to_string(&view).unwrap();
        let deserialized: TableInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.table_type, "VIEW");
        assert!(deserialized.engine.is_none());
    }

    #[test]
    fn test_connection_config_serialization() {
        let config = ConnectionConfig {
            id: Some("test-id".to_string()),
            database_type: DatabaseType::MySql,
            name: "Test Connection".to_string(),
            host: "localhost".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: Some("password".to_string()),
            database: Some("testdb".to_string()),
            sqlite_path: None,
            ssh: None,
            ssl_mode: None,
            ssl_ca_path: None,
            ssl_pkcs12_path: None,
            ssl_pkcs12_password: None,
            ssl_tls_hostname: None,
            client_charset: None,
            session_init_commands: None,
            read_only: None,
            skip_dangerous_sql_confirm: None,
            group_id: None,
        };

        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ConnectionConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.name, "Test Connection");
        assert_eq!(deserialized.host, "localhost");
        assert_eq!(deserialized.port, 3306);
        assert_eq!(deserialized.database, Some("testdb".to_string()));
        assert!(deserialized.ssh.is_none());
    }

    #[test]
    fn test_connection_config_debug_redacts_secrets() {
        let config = ConnectionConfig {
            id: Some("id".to_string()),
            database_type: DatabaseType::MySql,
            name: "n".to_string(),
            host: "h".to_string(),
            port: 3306,
            username: "u".to_string(),
            password: Some("real-db-pass".to_string()),
            database: None,
            sqlite_path: None,
            ssh: Some(SshConfig {
                host: "ssh".to_string(),
                port: 22,
                username: "su".to_string(),
                password: Some("real-ssh-pass".to_string()),
                private_key_path: Some("/home/u/.ssh/id_rsa".to_string()),
            }),
            ssl_mode: None,
            ssl_ca_path: None,
            ssl_pkcs12_path: None,
            ssl_pkcs12_password: Some("pk12".to_string()),
            ssl_tls_hostname: None,
            client_charset: None,
            session_init_commands: None,
            read_only: None,
            skip_dangerous_sql_confirm: None,
            group_id: None,
        };

        let debug = format!("{:?}", config);
        assert!(debug.contains(PASSWORD_REDACTED));
        assert!(!debug.contains("real-db-pass"));
        assert!(!debug.contains("real-ssh-pass"));
        assert!(!debug.contains("pk12"));
    }

    #[test]
    fn test_connection_config_with_ssh() {
        let config = ConnectionConfig {
            id: None,
            database_type: DatabaseType::MySql,
            name: "SSH Connection".to_string(),
            host: "db.example.com".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: Some("dbpass".to_string()),
            database: None,
            sqlite_path: None,
            ssh: Some(SshConfig {
                host: "ssh.example.com".to_string(),
                port: 22,
                username: "sshuser".to_string(),
                password: Some("sshpass".to_string()),
                private_key_path: None,
            }),
            ssl_mode: Some("required".to_string()),
            ssl_ca_path: None,
            ssl_pkcs12_path: None,
            ssl_pkcs12_password: None,
            ssl_tls_hostname: None,
            client_charset: None,
            session_init_commands: None,
            read_only: None,
            skip_dangerous_sql_confirm: None,
            group_id: None,
        };

        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ConnectionConfig = serde_json::from_str(&json).unwrap();

        assert!(deserialized.ssh.is_some());
        let ssh = deserialized.ssh.unwrap();
        assert_eq!(ssh.host, "ssh.example.com");
        assert_eq!(ssh.port, 22);
        assert_eq!(ssh.username, "sshuser");
    }

    #[test]
    fn test_connection_config_deserialize_without_ssl_fields() {
        let json = r#"{"name":"L","host":"h","port":3306,"username":"u","password":null,"database":null,"ssh":null}"#;
        let c: ConnectionConfig = serde_json::from_str(json).unwrap();
        assert_eq!(c.database_type, DatabaseType::MySql);
        assert!(c.ssl_mode.is_none());
        assert!(c.ssl_ca_path.is_none());
    }

    #[test]
    fn test_connection_config_serializes_database_type() {
        let config = ConnectionConfig {
            id: Some("test-id".to_string()),
            database_type: DatabaseType::MySql,
            name: "Test Connection".to_string(),
            host: "localhost".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: None,
            database: None,
            sqlite_path: None,
            ssh: None,
            ssl_mode: None,
            ssl_ca_path: None,
            ssl_pkcs12_path: None,
            ssl_pkcs12_password: None,
            ssl_tls_hostname: None,
            client_charset: None,
            session_init_commands: None,
            read_only: None,
            skip_dangerous_sql_confirm: None,
            group_id: None,
        };

        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("\"database_type\":\"mysql\""));
        let deserialized: ConnectionConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.database_type, DatabaseType::MySql);
    }

    #[test]
    fn test_connection_config_serializes_sqlite_type_and_path() {
        let json = r#"{"database_type":"sqlite","name":"Local","host":"","port":0,"username":"","password":null,"database":null,"sqlite_path":"/tmp/app.db","ssh":null}"#;
        let c: ConnectionConfig = serde_json::from_str(json).unwrap();
        assert_eq!(c.database_type, DatabaseType::Sqlite);
        assert_eq!(c.sqlite_path.as_deref(), Some("/tmp/app.db"));
    }

    #[test]
    fn test_connection_config_serializes_sqlserver_type() {
        let json = r#"{"database_type":"sqlserver","name":"MSSQL","host":"sql.example.com","port":1433,"username":"sa","password":null,"database":"appdb","ssh":null}"#;
        let c: ConnectionConfig = serde_json::from_str(json).unwrap();
        assert_eq!(c.database_type, DatabaseType::SqlServer);
        assert_eq!(c.port, 1433);
        assert_eq!(c.database.as_deref(), Some("appdb"));

        let serialized = serde_json::to_string(&c).unwrap();
        assert!(serialized.contains("\"database_type\":\"sqlserver\""));
    }

    #[test]
    fn test_connection_config_serializes_clickhouse_type() {
        let json = r#"{"database_type":"clickhouse","name":"ClickHouse","host":"ch.example.com","port":8123,"username":"default","password":null,"database":"analytics","ssh":null}"#;
        let c: ConnectionConfig = serde_json::from_str(json).unwrap();
        assert_eq!(c.database_type, DatabaseType::ClickHouse);
        assert_eq!(c.port, 8123);
        assert_eq!(c.database.as_deref(), Some("analytics"));

        let serialized = serde_json::to_string(&c).unwrap();
        assert!(serialized.contains("\"database_type\":\"clickhouse\""));
    }

    #[test]
    fn test_query_result_serialization() {
        let result = QueryResult {
            columns: vec!["id".to_string(), "name".to_string()],
            rows: vec![
                vec![serde_json::json!(1), serde_json::json!("Alice")],
                vec![serde_json::json!(2), serde_json::json!("Bob")],
            ],
            total: 100,
            execution_time_ms: 15,
        };

        let json = serde_json::to_string(&result).unwrap();
        let deserialized: QueryResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.columns.len(), 2);
        assert_eq!(deserialized.rows.len(), 2);
        assert_eq!(deserialized.total, 100);
        assert_eq!(deserialized.execution_time_ms, 15);
    }

    #[test]
    fn test_session_info_serialization() {
        let s = SessionInfo {
            version: "8.0.36".into(),
            hostname: "db-1".into(),
            server_read_only: false,
            max_execution_time_ms: 0,
            time_zone: "SYSTEM".into(),
            database: Some("app".into()),
            connection_id: 42,
            grant_write_capable: true,
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: SessionInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.connection_id, 42);
        assert_eq!(back.database, Some("app".into()));
    }

    #[test]
    fn test_sql_execute_result_select() {
        let result = SqlExecuteResult {
            result_type: "select".to_string(),
            columns: Some(vec!["id".to_string()]),
            rows: Some(vec![vec![serde_json::json!(1)]]),
            affected_rows: None,
            message: "查询完成".to_string(),
            execution_time_ms: 5,
        };

        let json = serde_json::to_string(&result).unwrap();
        let deserialized: SqlExecuteResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.result_type, "select");
        assert!(deserialized.columns.is_some());
        assert!(deserialized.rows.is_some());
        assert!(deserialized.affected_rows.is_none());
    }

    #[test]
    fn test_sql_execute_result_modify() {
        let result = SqlExecuteResult {
            result_type: "modify".to_string(),
            columns: None,
            rows: None,
            affected_rows: Some(3),
            message: "影响 3 行".to_string(),
            execution_time_ms: 10,
        };

        let json = serde_json::to_string(&result).unwrap();
        let deserialized: SqlExecuteResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.result_type, "modify");
        assert!(deserialized.columns.is_none());
        assert_eq!(deserialized.affected_rows, Some(3));
    }

    #[test]
    fn test_import_sql_file_result_serialization() {
        let r = ImportSqlFileResult {
            statements_total: 10,
            statements_ok: 8,
            statements_failed: 2,
            failures: vec![
                ImportSqlStatementFailure {
                    statement_index: 3,
                    statement_preview: "CREATE TABLE users".to_string(),
                    error: "syntax".to_string(),
                },
                ImportSqlStatementFailure {
                    statement_index: 7,
                    statement_preview: "INSERT INTO users".to_string(),
                    error: "dup".to_string(),
                },
            ],
            elapsed_ms: 100,
        };
        let json = serde_json::to_string(&r).unwrap();
        let d: ImportSqlFileResult = serde_json::from_str(&json).unwrap();
        assert_eq!(d.statements_total, 10);
        assert_eq!(d.statements_failed, 2);
        assert_eq!(d.failures.len(), 2);
        assert_eq!(d.failures[0].statement_index, 3);
        assert_eq!(d.failures[0].statement_preview, "CREATE TABLE users");
    }

    #[test]
    fn test_export_sql_file_result_serialization() {
        let r = ExportSqlFileResult {
            tables_exported: 2,
            views_exported: 1,
            triggers_exported: 3,
            events_exported: 1,
            insert_rows: 500,
            file_path: "/tmp/dump.sql".to_string(),
            elapsed_ms: 2000,
        };
        let json = serde_json::to_string(&r).unwrap();
        let d: ExportSqlFileResult = serde_json::from_str(&json).unwrap();
        assert_eq!(d.tables_exported, 2);
        assert_eq!(d.triggers_exported, 3);
        assert_eq!(d.insert_rows, 500);
    }

    #[test]
    fn test_index_info_serialization() {
        let index = IndexInfo {
            name: "idx_name".to_string(),
            unique: true,
            index_type: "BTREE".to_string(),
            columns: vec![IndexColumnInfo {
                column_name: "name".to_string(),
                seq_in_index: 1,
                collation: Some("A".to_string()),
                sub_part: None,
            }],
            is_primary: false,
            comment: "名称索引".to_string(),
        };

        let json = serde_json::to_string(&index).unwrap();
        let deserialized: IndexInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.name, "idx_name");
        assert!(deserialized.unique);
        assert_eq!(deserialized.index_type, "BTREE");
        assert_eq!(deserialized.columns.len(), 1);
        assert!(!deserialized.is_primary);
    }

    #[test]
    fn test_create_index_request_serialization() {
        let request = CreateIndexRequest {
            index_name: "idx_email".to_string(),
            index_type: "UNIQUE".to_string(),
            index_method: Some("BTREE".to_string()),
            columns: vec![CreateIndexColumn {
                column_name: "email".to_string(),
                length: Some(50),
                order: Some("ASC".to_string()),
            }],
            comment: Some("邮箱索引".to_string()),
        };

        let json = serde_json::to_string(&request).unwrap();
        let deserialized: CreateIndexRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.index_name, "idx_email");
        assert_eq!(deserialized.columns[0].length, Some(50));
        assert_eq!(deserialized.columns[0].order, Some("ASC".to_string()));
    }

    #[test]
    fn test_index_column_info_serialization() {
        let col = IndexColumnInfo {
            column_name: "user_id".to_string(),
            seq_in_index: 2,
            collation: Some("D".to_string()),
            sub_part: Some(10),
        };

        let json = serde_json::to_string(&col).unwrap();
        let deserialized: IndexColumnInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.column_name, "user_id");
        assert_eq!(deserialized.seq_in_index, 2);
        assert_eq!(deserialized.collation, Some("D".to_string()));
        assert_eq!(deserialized.sub_part, Some(10));
    }

    #[test]
    fn test_trigger_info_serialization() {
        let trigger = TriggerInfo {
            name: "trg_before_insert".to_string(),
            event: "INSERT".to_string(),
            timing: "BEFORE".to_string(),
            table_name: "users".to_string(),
            statement: "SET NEW.created_at = NOW()".to_string(),
            created: Some("2026-01-01 00:00:00".to_string()),
            sql_mode: "STRICT_TRANS_TABLES".to_string(),
            definer: "root@localhost".to_string(),
        };

        let json = serde_json::to_string(&trigger).unwrap();
        let deserialized: TriggerInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.name, "trg_before_insert");
        assert_eq!(deserialized.event, "INSERT");
        assert_eq!(deserialized.timing, "BEFORE");
        assert_eq!(deserialized.table_name, "users");
        assert_eq!(deserialized.statement, "SET NEW.created_at = NOW()");
        assert_eq!(deserialized.definer, "root@localhost");
    }

    #[test]
    fn test_trigger_info_without_created() {
        let trigger = TriggerInfo {
            name: "trg_after_update".to_string(),
            event: "UPDATE".to_string(),
            timing: "AFTER".to_string(),
            table_name: "orders".to_string(),
            statement: "INSERT INTO audit_log VALUES (OLD.id, NOW())".to_string(),
            created: None,
            sql_mode: "".to_string(),
            definer: "admin@%".to_string(),
        };

        let json = serde_json::to_string(&trigger).unwrap();
        let deserialized: TriggerInfo = serde_json::from_str(&json).unwrap();
        assert!(deserialized.created.is_none());
        assert_eq!(deserialized.event, "UPDATE");
        assert_eq!(deserialized.timing, "AFTER");
    }

    #[test]
    fn test_create_trigger_request_serialization() {
        let request = CreateTriggerRequest {
            name: "trg_before_delete".to_string(),
            timing: "BEFORE".to_string(),
            event: "DELETE".to_string(),
            body:
                "BEGIN\n  INSERT INTO deleted_records SELECT * FROM users WHERE id = OLD.id;\nEND"
                    .to_string(),
        };

        let json = serde_json::to_string(&request).unwrap();
        let deserialized: CreateTriggerRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.name, "trg_before_delete");
        assert_eq!(deserialized.timing, "BEFORE");
        assert_eq!(deserialized.event, "DELETE");
        assert!(deserialized.body.contains("BEGIN"));
        assert!(deserialized.body.contains("END"));
    }

    #[test]
    fn test_alter_column_request_serialization() {
        let request = AlterColumnRequest {
            old_name: "username".to_string(),
            new_name: "user_name".to_string(),
            column_type: "varchar(128)".to_string(),
            nullable: false,
            default_value: None,
            extra: "".to_string(),
            comment: "用户名".to_string(),
            is_primary: Some(false),
            column_placement: None,
        };

        let json = serde_json::to_string(&request).unwrap();
        let deserialized: AlterColumnRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.old_name, "username");
        assert_eq!(deserialized.new_name, "user_name");
        assert_eq!(deserialized.column_type, "varchar(128)");
        assert!(!deserialized.nullable);
        assert!(deserialized.default_value.is_none());
        assert_eq!(deserialized.comment, "用户名");
        assert_eq!(deserialized.is_primary, Some(false));
        assert!(deserialized.column_placement.is_none());
    }

    #[test]
    fn test_alter_column_request_deserialize_without_placement() {
        let json = r#"{"old_name":"x","new_name":"x","column_type":"int","nullable":true,"default_value":null,"extra":"","comment":"","is_primary":null}"#;
        let r: AlterColumnRequest = serde_json::from_str(json).unwrap();
        assert!(r.column_placement.is_none());
    }

    #[test]
    fn test_alter_column_request_deserialize_without_is_primary() {
        let json = r#"{"old_name":"x","new_name":"x","column_type":"int","nullable":true,"default_value":null,"extra":"","comment":""}"#;
        let r: AlterColumnRequest = serde_json::from_str(json).unwrap();
        assert!(r.is_primary.is_none());
        assert!(r.column_placement.is_none());
    }

    #[test]
    fn test_alter_column_placement_roundtrip_json() {
        let p = AlterColumnPlacement::After {
            column: "prev".to_string(),
        };
        let j = serde_json::to_string(&p).unwrap();
        let back: AlterColumnPlacement = serde_json::from_str(&j).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn test_alter_column_request_with_default() {
        let request = AlterColumnRequest {
            old_name: "status".to_string(),
            new_name: "status".to_string(),
            column_type: "tinyint".to_string(),
            nullable: false,
            default_value: Some("1".to_string()),
            extra: "".to_string(),
            comment: "状态".to_string(),
            is_primary: None,
            column_placement: None,
        };

        let json = serde_json::to_string(&request).unwrap();
        let deserialized: AlterColumnRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.old_name, "status");
        assert_eq!(deserialized.default_value, Some("1".to_string()));
    }

    #[test]
    fn test_add_column_request_serialization() {
        let request = AddColumnRequest {
            name: "email".to_string(),
            column_type: "varchar(255)".to_string(),
            nullable: true,
            default_value: None,
            extra: "".to_string(),
            comment: "邮箱地址".to_string(),
            after_column: Some("username".to_string()),
        };

        let json = serde_json::to_string(&request).unwrap();
        let deserialized: AddColumnRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.name, "email");
        assert_eq!(deserialized.column_type, "varchar(255)");
        assert!(deserialized.nullable);
        assert!(deserialized.default_value.is_none());
        assert_eq!(deserialized.after_column, Some("username".to_string()));
        assert_eq!(deserialized.comment, "邮箱地址");
    }

    #[test]
    fn test_add_column_request_at_end() {
        let request = AddColumnRequest {
            name: "created_at".to_string(),
            column_type: "datetime".to_string(),
            nullable: false,
            default_value: Some("CURRENT_TIMESTAMP".to_string()),
            extra: "".to_string(),
            comment: "创建时间".to_string(),
            after_column: None,
        };

        let json = serde_json::to_string(&request).unwrap();
        let deserialized: AddColumnRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.name, "created_at");
        assert!(deserialized.after_column.is_none());
        assert_eq!(
            deserialized.default_value,
            Some("CURRENT_TIMESTAMP".to_string())
        );
    }

    #[test]
    fn test_ssh_config_with_private_key() {
        let ssh = SshConfig {
            host: "ssh.example.com".to_string(),
            port: 22,
            username: "user".to_string(),
            password: None,
            private_key_path: Some("/home/user/.ssh/id_rsa".to_string()),
        };

        let json = serde_json::to_string(&ssh).unwrap();
        let deserialized: SshConfig = serde_json::from_str(&json).unwrap();

        assert!(deserialized.password.is_none());
        assert_eq!(
            deserialized.private_key_path,
            Some("/home/user/.ssh/id_rsa".to_string())
        );
    }
}
