/** SSH 隧道配置 */
export interface SshConfig {
  /** SSH 服务器地址 */
  host: string;
  /** SSH 服务器端口 */
  port: number;
  /** SSH 用户名 */
  username: string;
  /** SSH 密码 (密码认证) */
  password?: string;
  /** SSH 私钥路径 (密钥认证) */
  private_key_path?: string;
}

/** 数据库类型 */
export type DatabaseType = "mysql" | "postgres" | "sqlite" | "sqlserver";

/** 数据库连接配置 */
export interface ConnectionConfig {
  /** 唯一标识 (保存时自动生成) */
  id?: string;
  /** 数据库类型；旧连接缺省时等同 mysql */
  database_type?: DatabaseType;
  /** 连接名称 */
  name: string;
  /** 数据库主机地址 */
  host: string;
  /** 数据库端口 */
  port: number;
  /** 数据库用户名 */
  username: string;
  /** 数据库密码 (可选) */
  password?: string;
  /** 默认数据库 (可选) */
  database?: string;
  /** SQLite 数据库文件路径 */
  sqlite_path?: string;
  /** SSH 隧道配置 (undefined 表示直连) */
  ssh?: SshConfig;
  /** SSL：disabled | required | verify_ca | verify_identity | required_insecure（缺省等同 disabled） */
  ssl_mode?: string;
  /** PEM 格式 CA 证书路径（verify_ca / verify_identity） */
  ssl_ca_path?: string;
  /** PKCS#12 客户端证书路径（可选） */
  ssl_pkcs12_path?: string;
  /** PKCS#12 密码（可选） */
  ssl_pkcs12_password?: string;
  /** TLS 校验用主机名（经隧道连接 RDS 等时可填） */
  ssl_tls_hostname?: string;
  /** 客户端字符集（SET NAMES），默认服务端行为+后端默认 utf8mb4 */
  client_charset?: string;
  /** 连接建立后依次执行的会话 SQL */
  session_init_commands?: string[];
  /** 只读：禁止写类操作与 SQL 编辑器中的 DML/DDL */
  read_only?: boolean;
  /** 为 true 时，SQL 编辑器对 TRUNCATE / DROP DATABASE 等不再弹出二次确认（不推荐） */
  skip_dangerous_sql_confirm?: boolean;
  /** 所属连接分组；undefined 表示未分组 */
  group_id?: string;
}

/** 连接分组 */
export interface ConnectionGroup {
  id: string;
  name: string;
  collapsed?: boolean;
}

/** 连接导入结果 */
export interface ConnectionImportResult {
  imported_connections: number;
  imported_groups: number;
}

/** 当前连接会话信息（get_session_info） */
export interface SessionInfo {
  version: string;
  hostname: string;
  server_read_only: boolean;
  max_execution_time_ms: number;
  time_zone: string;
  database: string | null;
  connection_id: number;
  /** SHOW GRANTS 推断：是否具有写类权限（仅 SELECT/USAGE 等为 false） */
  grant_write_capable: boolean;
}

export interface SqlCompletionTable {
  name: string;
}

export interface SqlCompletionColumn {
  table: string;
  name: string;
  type?: string | null;
}

export interface SqlCompletionMetadata {
  databases: string[];
  tables: SqlCompletionTable[];
  columns: SqlCompletionColumn[];
}

/** 运行时环境信息（用于崩溃 breadcrumb） */
export interface RuntimeInfo {
  os_name: string;
  os_version: string;
  webkit_version: string | null;
  arch: string;
}

/** 连接测试结果 */
export interface TestResult {
  success: boolean;
  message: string;
  /** 连接耗时 (毫秒) */
  latency_ms: number;
}

/** 连接类型 */
export type ConnectionType = "direct" | "ssh";

/** 活跃连接信息 */
export interface ActiveConnection {
  /** 连接 ID (由后端生成) */
  connId: string;
  /** 连接配置 */
  config: ConnectionConfig;
  /**
   * 与 `SessionInfo.grant_write_capable` 一致；false 时界面按只读灰显（与连接项「只读连接」叠加）。
   * 未从服务端拉取前为 undefined。
   */
  sessionGrantWriteCapable?: boolean;
}

/** 数据库信息 (字符集/排序规则) */
export interface DatabaseInfo {
  /** 数据库名称 */
  name: string;
  /** 默认字符集 */
  character_set: string;
  /** 默认排序规则 */
  collation: string;
}

/** 表信息 */
export interface TableInfo {
  /** 表名 */
  name: string;
  /** 类型: "TABLE" 或 "VIEW" */
  table_type: string;
  /** 存储引擎 (视图为 null) */
  engine: string | null;
  /** 预估行数 */
  rows: number | null;
  /** 数据大小 (字节) */
  data_length: number | null;
  /** 索引大小 (字节) */
  index_length: number | null;
  /** 表注释 */
  comment: string;
}

/** 列信息 */
export interface ColumnInfo {
  /** 列名 */
  name: string;
  /** 数据类型 */
  column_type: string;
  /** 是否允许 NULL */
  nullable: boolean;
  /** 键类型: "PRI", "UNI", "MUL", 或空字符串 */
  key: string;
  /** 默认值 */
  default_value: string | null;
  /** 额外信息 */
  extra: string;
  /** 列注释 */
  comment: string;
}

/** 索引信息 */
export interface IndexInfo {
  /** 索引名称 */
  name: string;
  /** 是否唯一索引 */
  unique: boolean;
  /** 索引类型: "BTREE", "HASH", "FULLTEXT", "SPATIAL" */
  index_type: string;
  /** 索引关联的列列表 (有序) */
  columns: IndexColumnInfo[];
  /** 是否为主键 */
  is_primary: boolean;
  /** 索引注释 */
  comment: string;
}

/** 索引中的列信息 */
export interface IndexColumnInfo {
  /** 列名 */
  column_name: string;
  /** 在索引中的顺序 (从 1 开始) */
  seq_in_index: number;
  /** 排序方式: "A" (ASC), "D" (DESC), 或 null */
  collation: string | null;
  /** 子部分 (前缀长度) */
  sub_part: number | null;
}

/** 创建索引的请求参数 */
export interface CreateIndexRequest {
  /** 索引名称 */
  index_name: string;
  /** 索引类型: "INDEX", "UNIQUE", "FULLTEXT", "SPATIAL" */
  index_type: string;
  /** 索引方法: "BTREE" 或 "HASH" (可选) */
  index_method?: string;
  /** 要索引的列 */
  columns: CreateIndexColumn[];
  /** 索引注释 (可选) */
  comment?: string;
}

/** 创建索引时的列定义 */
export interface CreateIndexColumn {
  /** 列名 */
  column_name: string;
  /** 前缀长度 (可选) */
  length?: number;
  /** 排序方式: "ASC" 或 "DESC" */
  order?: string;
}

/** 触发器信息 */
export interface TriggerInfo {
  /** 触发器名称 */
  name: string;
  /** 事件: "INSERT", "UPDATE", "DELETE" */
  event: string;
  /** 时机: "BEFORE" 或 "AFTER" */
  timing: string;
  /** 关联的表名 */
  table_name: string;
  /** 触发器语句体 */
  statement: string;
  /** 创建时间 */
  created: string | null;
  /** SQL 模式 */
  sql_mode: string;
  /** 定义者 */
  definer: string;
}

/** 创建触发器的请求参数 */
export interface CreateTriggerRequest {
  /** 触发器名称 */
  name: string;
  /** 时机: "BEFORE" 或 "AFTER" */
  timing: string;
  /** 事件: "INSERT", "UPDATE", "DELETE" */
  event: string;
  /** 触发器语句体 */
  body: string;
}

/** 外键信息（相对当前表：outgoing / incoming） */
export interface ForeignKeyInfo {
  constraint_name: string;
  direction: string;
  table_schema: string;
  table_name: string;
  column_names: string[];
  referenced_table_schema: string;
  referenced_table_name: string;
  referenced_column_names: string[];
  update_rule: string;
  delete_rule: string;
}

/** 添加外键向导请求 */
export interface AddForeignKeyRequest {
  constraint_name: string;
  columns: string[];
  referenced_table: string;
  referenced_columns: string[];
  on_update: string;
  on_delete: string;
}

/** 存储过程 / 函数 */
export interface RoutineInfo {
  name: string;
  routine_type: string;
  data_type: string | null;
  definer: string;
  security_type: string;
  routine_comment: string;
  created: string | null;
  last_altered: string | null;
  identity_arguments?: string | null;
}

/** 定时事件 */
export interface EventInfo {
  name: string;
  definer: string;
  time_zone: string;
  event_type: string;
  execute_at: string | null;
  interval_value: string | null;
  interval_field: string | null;
  starts: string | null;
  ends: string | null;
  status: string;
  originator: string | null;
  character_set_client: string;
  collation_connection: string;
  database_collation: string;
}

/** 修改列时调整物理顺序（对应 MODIFY/CHANGE 的 FIRST / AFTER） */
export type AlterColumnPlacement =
  | { kind: "first" }
  | { kind: "after"; column: string };

/** 修改列的请求参数 */
export interface AlterColumnRequest {
  /** 原列名 (用于 CHANGE COLUMN) */
  old_name: string;
  /** 新列名 */
  new_name: string;
  /** 数据类型 (如 varchar(255)) */
  column_type: string;
  /** 是否允许 NULL */
  nullable: boolean;
  /** 默认值 */
  default_value: string | null;
  /** 额外属性 (如 auto_increment) */
  extra: string;
  /** 列注释 */
  comment: string;
  /** 是否为主键（不传则不变更主键状态） */
  is_primary?: boolean;
  /** 列顺序：不传则保持原位置，仅更新定义 */
  column_placement?: AlterColumnPlacement;
}

/** 新增列的请求参数 */
export interface AddColumnRequest {
  /** 列名 */
  name: string;
  /** 数据类型 (如 varchar(255)) */
  column_type: string;
  /** 是否允许 NULL */
  nullable: boolean;
  /** 默认值 */
  default_value: string | null;
  /** 额外属性 (如 auto_increment) */
  extra: string;
  /** 列注释 */
  comment: string;
  /** 在哪个列之后 (null = 末尾) */
  after_column: string | null;
}

/** 新建表时的列定义 */
export interface CreateTableColumnDef {
  /** 列名 */
  name: string;
  /** 数据类型 (如 varchar(255)) */
  column_type: string;
  /** 是否允许 NULL */
  nullable: boolean;
  /** 默认值 */
  default_value: string | null;
  /** 额外属性 (如 auto_increment) */
  extra: string;
  /** 列注释 */
  comment: string;
}

/** 新建表的请求参数 */
export interface CreateTableRequest {
  /** 表名 */
  table_name: string;
  /** 列定义列表 */
  columns: CreateTableColumnDef[];
  /** 主键列名列表 */
  primary_keys: string[];
  /** 存储引擎 (如 InnoDB) */
  engine: string;
  /** 表注释 */
  comment: string;
}

/** 表数据查询结果 */
export interface QueryResult {
  /** 列名列表 */
  columns: string[];
  /** 行数据 (每行是值数组, 与 columns 对应) */
  rows: unknown[][];
  /** 满足条件的总行数 */
  total: number;
  /** 查询耗时 (毫秒) */
  execution_time_ms: number;
}

/** SQL 执行结果 */
export interface SqlExecuteResult {
  /** 结果类型: "select" | "modify" | "error" */
  result_type: string;
  /** 列名 (仅 SELECT 时有值) */
  columns: string[] | null;
  /** 行数据 (仅 SELECT 时有值) */
  rows: unknown[][] | null;
  /** 影响行数 (仅 INSERT/UPDATE/DELETE 时有值) */
  affected_rows: number | null;
  /** 提示消息 */
  message: string;
  /** 执行耗时 (毫秒) */
  execution_time_ms: number;
}

/** 单条导入失败记录 */
export interface ImportSqlStatementFailure {
  statement_index: number;
  statement_preview?: string;
  error: string;
}

/** SQL 文件导入前识别出的高危语句摘要 */
export interface DangerousSqlStatementPreview {
  statement_index: number;
  statement_preview: string;
}

/** SQL 文件导入预检结果 */
export interface PreviewSqlFileImportResult {
  statements_total: number;
  dangerous_statements_total: number;
  dangerous_statements: DangerousSqlStatementPreview[];
}

/** 自文件导入 SQL 的执行结果（失败条目不中断整体导入） */
export interface ImportSqlFileResult {
  statements_total: number;
  statements_ok: number;
  statements_failed: number;
  failures: ImportSqlStatementFailure[];
  elapsed_ms: number;
}

/** 导出数据库为 .sql 文件的结果 */
export interface ExportSqlFileResult {
  tables_exported: number;
  views_exported: number;
  triggers_exported: number;
  events_exported: number;
  insert_rows: number;
  file_path: string;
  elapsed_ms: number;
}
