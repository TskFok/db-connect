import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionConfig,
  ConnectionGroup,
  ConnectionImportResult,
  TestResult,
  DatabaseInfo,
  TableInfo,
  ColumnInfo,
  QueryResult,
  SqlExecuteResult,
  SqlCompletionMetadata,
  SessionInfo,
  RuntimeInfo,
  ImportSqlFileResult,
  PreviewSqlFileImportResult,
  ExportSqlFileResult,
  IndexInfo,
  CreateIndexRequest,
  TriggerInfo,
  CreateTriggerRequest,
  AlterColumnRequest,
  AddColumnRequest,
  CreateTableRequest,
  ForeignKeyInfo,
  AddForeignKeyRequest,
  RoutineInfo,
  EventInfo,
} from "../types";

type SessionInfoCacheEntry = {
  value: SessionInfo;
  expiresAt: number;
};

const SESSION_INFO_CACHE_TTL_MS = 30_000;
const sessionInfoCache = new Map<string, SessionInfoCacheEntry>();
const sessionInfoInflight = new Map<string, Promise<SessionInfo>>();

function sessionInfoCacheKey(connId: string, database: string | null): string {
  return `${connId}::${database ?? ""}`;
}

/**
 * 测试数据库连接
 */
export async function testConnection(
  config: ConnectionConfig
): Promise<TestResult> {
  return invoke<TestResult>("test_connection", { config });
}

/**
 * 建立数据库连接，返回连接 ID
 */
export async function connect(config: ConnectionConfig): Promise<string> {
  return invoke<string>("connect", { config });
}

/** 将 UTF-8 文本写入用户选择的绝对路径 */
export async function writeTextFile(
  path: string,
  contents: string
): Promise<void> {
  return invoke<void>("write_text_file", { path, contents });
}

/** 将 Base64 二进制内容写入用户选择的绝对路径（如 xlsx） */
export async function writeBinaryFile(
  path: string,
  contentsBase64: string
): Promise<void> {
  return invoke<void>("write_binary_file", {
    path,
    contentsBase64,
  });
}

/**
 * 断开数据库连接
 */
export async function disconnect(connId: string): Promise<void> {
  return invoke<void>("disconnect", { connId });
}

/**
 * 探测连接是否仍然可用（带超时，SELECT 1）。
 * 用于屏幕休眠 / 网络切换后恢复时检查连接是否已被对端掐断。
 * @returns true 表示存活；false 表示已失效或不存在
 */
export async function pingConnection(connId: string): Promise<boolean> {
  return invoke<boolean>("ping_connection", { connId });
}

/**
 * 强制清理连接（不报错地移除底层资源）。
 * 用于连接已被对端 / 中间设备 / 系统休眠掐断、常规 disconnect 可能卡住的场景。
 */
export async function forceDisconnect(connId: string): Promise<void> {
  return invoke<void>("force_disconnect", { connId });
}

/**
 * 获取当前运行时信息（OS / WebKit 版本）
 */
export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  return invoke<RuntimeInfo>("get_runtime_info");
}

/**
 * 检查空闲超时并断开连接，减少凭据驻留时间
 * @returns true 表示已因空闲超时断开，false 表示未超时
 */
export async function checkIdleDisconnect(
  connId: string,
  idleTimeoutSecs: number
): Promise<boolean> {
  return invoke<boolean>("check_idle_disconnect", {
    connId,
    idleTimeoutSecs,
  });
}

/**
 * 保存连接配置
 */
export async function saveConnection(config: ConnectionConfig): Promise<void> {
  return invoke<void>("save_connection", { config });
}

/**
 * 获取所有已保存的连接配置（密码已脱敏）
 */
export async function listSavedConnections(): Promise<ConnectionConfig[]> {
  return invoke<ConnectionConfig[]>("list_saved_connections");
}

/** 获取连接分组 */
export async function listConnectionGroups(): Promise<ConnectionGroup[]> {
  return invoke<ConnectionGroup[]>("list_connection_groups");
}

/** 创建连接分组 */
export async function createConnectionGroup(
  name: string
): Promise<ConnectionGroup> {
  return invoke<ConnectionGroup>("create_connection_group", { name });
}

/** 重命名连接分组 */
export async function renameConnectionGroup(
  id: string,
  name: string
): Promise<void> {
  return invoke<void>("rename_connection_group", { id, name });
}

/** 删除连接分组；组内连接回到未分组 */
export async function deleteConnectionGroup(id: string): Promise<void> {
  return invoke<void>("delete_connection_group", { id });
}

/** 设置连接分组折叠状态 */
export async function setConnectionGroupCollapsed(
  id: string,
  collapsed: boolean
): Promise<void> {
  return invoke<void>("set_connection_group_collapsed", { id, collapsed });
}

/** 按指定顺序重新排列连接分组 */
export async function reorderConnectionGroups(ids: string[]): Promise<void> {
  return invoke<void>("reorder_connection_groups", { ids });
}

/** 移动连接到分组并保存新的全局连接顺序 */
export async function moveConnectionToGroup(
  connectionId: string,
  groupId: string | null,
  orderedIds: string[]
): Promise<void> {
  return invoke<void>("move_connection_to_group", {
    connectionId,
    groupId,
    orderedIds,
  });
}

/**
 * 获取指定连接的完整配置（含解密后的密码，用于编辑和连接）
 */
export async function getDecryptedConnection(
  id: string
): Promise<ConnectionConfig> {
  return invoke<ConnectionConfig>("get_decrypted_connection", { id });
}

/**
 * 删除已保存的连接配置
 */
export async function deleteSavedConnection(id: string): Promise<void> {
  return invoke<void>("delete_saved_connection", { id });
}

/**
 * 按指定顺序重新排列连接（自定义显示顺序）
 */
export async function reorderConnections(ids: string[]): Promise<void> {
  return invoke<void>("reorder_connections", { ids });
}

/**
 * 导出所有保存的连接和分组到指定文件；内容使用迁移密码加密。
 */
export async function exportConnections(
  path: string,
  password: string
): Promise<number> {
  return invoke<number>("export_connections", { path, password });
}

/**
 * 从加密迁移文件导入连接和分组；后端会解密、合并并生成新 ID。
 */
export async function importConnections(
  path: string,
  password: string
): Promise<ConnectionImportResult> {
  return invoke<ConnectionImportResult>("import_connections", {
    path,
    password,
  });
}

// ==================== 应用偏好（列设置等） ====================

/**
 * 获取表列设置（持久化到 Rust 端文件，关闭程序后仍保留）
 */
export async function getTableColumnSettings(): Promise<string | null> {
  return invoke<string | null>("get_table_column_settings");
}

/**
 * 保存表列设置
 */
export async function saveTableColumnSettings(
  value: string
): Promise<void> {
  return invoke<void>("save_table_column_settings", { value });
}

/**
 * 删除表列设置（用于 clearStorage）
 */
export async function deleteTableColumnSettings(): Promise<void> {
  return invoke<void>("delete_table_column_settings");
}

// ==================== 数据库浏览 ====================

/**
 * 获取数据库列表
 */
export async function listDatabases(connId: string): Promise<string[]> {
  return invoke<string[]>("list_databases", { connId });
}

/**
 * 获取数据库信息 (字符集/排序规则)
 */
export async function getDatabaseInfo(
  connId: string,
  database: string
): Promise<DatabaseInfo> {
  return invoke<DatabaseInfo>("get_database_info", { connId, database });
}

/**
 * 修改数据库字符集和排序规则
 */
export async function alterDatabaseCharset(
  connId: string,
  database: string,
  characterSet: string,
  collation: string
): Promise<void> {
  return invoke<void>("alter_database_charset", {
    connId,
    database,
    characterSet,
    collation,
  });
}

/**
 * 创建数据库（指定字符集和排序规则）
 */
export async function createDatabase(
  connId: string,
  name: string,
  characterSet: string,
  collation: string
): Promise<void> {
  return invoke<void>("create_database", {
    connId,
    name,
    characterSet,
    collation,
  });
}

/**
 * 删除数据库（不可恢复；服务端拒绝系统库）
 */
export async function dropDatabase(
  connId: string,
  database: string
): Promise<void> {
  return invoke<void>("drop_database", { connId, database });
}

/**
 * 重命名数据库 (创建新库 -> 迁移表 -> 删除旧库)
 */
export async function renameDatabase(
  connId: string,
  oldName: string,
  newName: string,
  characterSet: string,
  collation: string
): Promise<void> {
  return invoke<void>("rename_database", {
    connId,
    oldName,
    newName,
    characterSet,
    collation,
  });
}

/**
 * 重命名表
 */
export async function renameTable(
  connId: string,
  database: string,
  oldName: string,
  newName: string
): Promise<void> {
  return invoke<void>("rename_table", { connId, database, oldName, newName });
}

/**
 * 修改表引擎
 */
export async function alterTableEngine(
  connId: string,
  database: string,
  table: string,
  engine: string
): Promise<void> {
  return invoke<void>("alter_table_engine", { connId, database, table, engine });
}

/**
 * 获取表的主键列信息
 */
export async function getPrimaryKeys(
  connId: string,
  database: string,
  table: string
): Promise<string[]> {
  return invoke<string[]>("get_primary_keys", { connId, database, table });
}

/**
 * 修改列定义
 */
export async function alterColumn(
  connId: string,
  database: string,
  table: string,
  request: AlterColumnRequest
): Promise<void> {
  return invoke<void>("alter_column", { connId, database, table, request });
}

/**
 * 新增列
 */
export async function addColumn(
  connId: string,
  database: string,
  table: string,
  request: AddColumnRequest
): Promise<void> {
  return invoke<void>("add_column", { connId, database, table, request });
}

/**
 * 删除列
 */
/**
 * 新建表
 */
export async function createTable(
  connId: string,
  database: string,
  request: CreateTableRequest
): Promise<void> {
  return invoke<void>("create_table", { connId, database, request });
}

/**
 * 删除表
 */
export async function dropTable(
  connId: string,
  database: string,
  table: string
): Promise<void> {
  return invoke<void>("drop_table", { connId, database, table });
}

/**
 * 清空表（TRUNCATE TABLE）
 */
export async function truncateTable(
  connId: string,
  database: string,
  table: string
): Promise<void> {
  return invoke<void>("truncate_table", { connId, database, table });
}

/**
 * 删除列
 */
export async function dropColumn(
  connId: string,
  database: string,
  table: string,
  columnName: string
): Promise<void> {
  return invoke<void>("drop_column", { connId, database, table, columnName });
}

/**
 * 获取指定数据库的表列表
 */
export async function listTables(
  connId: string,
  database: string
): Promise<TableInfo[]> {
  return invoke<TableInfo[]>("list_tables", { connId, database });
}

/**
 * 获取表结构 (列信息)
 */
export async function getTableStructure(
  connId: string,
  database: string,
  table: string
): Promise<ColumnInfo[]> {
  return invoke<ColumnInfo[]>("get_table_structure", { connId, database, table });
}

/**
 * 批量获取 SQL 补全元数据（数据库/schema、表、列）
 */
export async function getSqlCompletionMetadata(
  connId: string,
  database: string | null
): Promise<SqlCompletionMetadata> {
  return invoke<SqlCompletionMetadata>("get_sql_completion_metadata", {
    connId,
    database,
  });
}

/**
 * 获取表的 CREATE TABLE/CREATE VIEW 语句
 */
export async function getTableDefinition(
  connId: string,
  database: string,
  table: string
): Promise<string> {
  return invoke<string>("get_table_definition", {
    connId,
    database,
    table,
  });
}

// ==================== 索引管理 ====================

/**
 * 获取指定表的索引列表
 */
export async function listIndexes(
  connId: string,
  database: string,
  table: string
): Promise<IndexInfo[]> {
  return invoke<IndexInfo[]>("list_indexes", { connId, database, table });
}

/**
 * 创建索引
 */
export async function createIndex(
  connId: string,
  database: string,
  table: string,
  request: CreateIndexRequest
): Promise<void> {
  return invoke<void>("create_index", { connId, database, table, request });
}

/**
 * 删除索引
 */
export async function deleteIndex(
  connId: string,
  database: string,
  table: string,
  indexName: string
): Promise<void> {
  return invoke<void>("delete_index", { connId, database, table, indexName });
}

// ==================== 触发器管理 ====================

/**
 * 获取触发器列表 (可按表名筛选)
 */
export async function listTriggers(
  connId: string,
  database: string,
  table?: string
): Promise<TriggerInfo[]> {
  return invoke<TriggerInfo[]>("list_triggers", {
    connId,
    database,
    table: table ?? null,
  });
}

/**
 * 获取触发器的完整 CREATE 语句
 */
export async function getTriggerDefinition(
  connId: string,
  database: string,
  triggerName: string,
  table?: string
): Promise<string> {
  return invoke<string>("get_trigger_definition", {
    connId,
    database,
    triggerName,
    table: table ?? null,
  });
}

/**
 * 创建触发器
 */
export async function createTrigger(
  connId: string,
  database: string,
  table: string,
  request: CreateTriggerRequest
): Promise<void> {
  return invoke<void>("create_trigger", { connId, database, table, request });
}

/**
 * 删除触发器
 */
export async function dropTrigger(
  connId: string,
  database: string,
  triggerName: string,
  table?: string
): Promise<void> {
  return invoke<void>("drop_trigger", {
    connId,
    database,
    triggerName,
    table: table ?? null,
  });
}

// ==================== 外键 ====================

export async function listForeignKeys(
  connId: string,
  database: string,
  table: string
): Promise<ForeignKeyInfo[]> {
  return invoke<ForeignKeyInfo[]>("list_foreign_keys", {
    connId,
    database,
    table,
  });
}

export async function addForeignKey(
  connId: string,
  database: string,
  table: string,
  request: AddForeignKeyRequest
): Promise<void> {
  return invoke<void>("add_foreign_key", {
    connId,
    database,
    table,
    request,
  });
}

export async function dropForeignKey(
  connId: string,
  database: string,
  table: string,
  constraintName: string
): Promise<void> {
  return invoke<void>("drop_foreign_key", {
    connId,
    database,
    table,
    constraintName,
  });
}

// ==================== 存储过程与函数 ====================

export async function listRoutines(
  connId: string,
  database: string,
  routineType: string | null
): Promise<RoutineInfo[]> {
  return invoke<RoutineInfo[]>("list_routines", {
    connId,
    database,
    routineType,
  });
}

export async function getRoutineDefinition(
  connId: string,
  database: string,
  routineName: string,
  routineType: string,
  identityArguments?: string | null
): Promise<string> {
  return invoke<string>("get_routine_definition", {
    connId,
    database,
    routineName,
    routineType,
    identityArguments: identityArguments ?? null,
  });
}

export async function dropRoutine(
  connId: string,
  database: string,
  routineName: string,
  routineType: string,
  identityArguments?: string | null
): Promise<void> {
  return invoke<void>("drop_routine", {
    connId,
    database,
    routineName,
    routineType,
    identityArguments: identityArguments ?? null,
  });
}

// ==================== 事件 ====================

export async function listEvents(
  connId: string,
  database: string
): Promise<EventInfo[]> {
  return invoke<EventInfo[]>("list_events", { connId, database });
}

export async function getEventDefinition(
  connId: string,
  database: string,
  eventName: string
): Promise<string> {
  return invoke<string>("get_event_definition", {
    connId,
    database,
    eventName,
  });
}

export async function dropEvent(
  connId: string,
  database: string,
  eventName: string
): Promise<void> {
  return invoke<void>("drop_event", { connId, database, eventName });
}

export async function setEventEnabled(
  connId: string,
  database: string,
  eventName: string,
  enabled: boolean
): Promise<void> {
  return invoke<void>("set_event_enabled", {
    connId,
    database,
    eventName,
    enabled,
  });
}

// ==================== 数据 CRUD ====================

/**
 * 查询表总行数 (用于分页，可与 queryTableData skipCount 配合实现数据与数量分离请求以加快首屏)
 */
export async function queryTableCount(
  connId: string,
  database: string,
  table: string,
  whereClause?: string
): Promise<number> {
  return invoke<number>("query_table_count", {
    connId,
    database,
    table,
    whereClause: whereClause ?? null,
  });
}

/** 表数据视图排序字段（顺序即 ORDER BY 优先级） */
export type TableSortField = {
  column: string;
  order: "ASC" | "DESC";
};

/**
 * 查询表数据 (分页)
 * @param selectColumns 可选的列列表，传入时仅查询指定列（后端自动合并主键列）；为空时使用 SELECT *
 * @param skipCount 为 true 时跳过 COUNT 查询以加快首屏显示，total 返回 0，可配合 queryTableCount 单独获取数量
 */
export async function queryTableData(
  connId: string,
  database: string,
  table: string,
  page: number,
  pageSize: number,
  sortFields: TableSortField[] | undefined,
  whereClause?: string,
  selectColumns?: string[],
  skipCount?: boolean
): Promise<QueryResult> {
  return invoke<QueryResult>("query_table_data", {
    connId,
    database,
    table,
    page,
    pageSize,
    sortFields:
      sortFields && sortFields.length > 0 ? sortFields : null,
    whereClause: whereClause ?? null,
    selectColumns: selectColumns ?? null,
    skipCount: skipCount ?? null,
  });
}

/**
 * 按主键查询完整行数据 (SELECT *)，用于"复制为 INSERT"等需要全量列的场景
 */
export async function queryFullRows(
  connId: string,
  database: string,
  table: string,
  primaryKeyColumn: string,
  primaryKeyValues: unknown[],
  primaryKeys?: Record<string, unknown>[]
): Promise<QueryResult> {
  const args: {
    connId: string;
    database: string;
    table: string;
    primaryKeyColumn: string;
    primaryKeyValues: unknown[];
    primaryKeys?: Record<string, unknown>[];
  } = {
    connId,
    database,
    table,
    primaryKeyColumn,
    primaryKeyValues,
  };
  if (primaryKeys !== undefined) {
    args.primaryKeys = primaryKeys;
  }
  return invoke<QueryResult>("query_full_rows", args);
}

/**
 * 插入一行数据
 */
export async function insertRow(
  connId: string,
  database: string,
  table: string,
  values: Record<string, unknown>
): Promise<number> {
  return invoke<number>("insert_row", { connId, database, table, values });
}

/**
 * 更新一行数据 (根据主键定位)
 */
export async function updateRow(
  connId: string,
  database: string,
  table: string,
  primaryKeys: Record<string, unknown>,
  updates: Record<string, unknown>
): Promise<number> {
  return invoke<number>("update_row", {
    connId,
    database,
    table,
    primaryKeys,
    updates,
  });
}

/** 批量更新的单行：主键定位 + 待更新列 */
export interface RowUpdate {
  primaryKeys: Record<string, unknown>;
  updates: Record<string, unknown>;
}

/**
 * 在单个事务中批量更新多行：任一行失败则整批回滚（不会发生部分提交）。
 * @returns 受影响的总行数
 */
export async function batchUpdateRows(
  connId: string,
  database: string,
  table: string,
  rows: RowUpdate[]
): Promise<number> {
  return invoke<number>("batch_update_rows", {
    connId,
    database,
    table,
    rows: rows.map(({ primaryKeys, updates }) => ({
      primary_keys: primaryKeys,
      updates,
    })),
  });
}

/**
 * 批量删除行 (根据主键)
 */
export async function deleteRows(
  connId: string,
  database: string,
  table: string,
  primaryKeys: Record<string, unknown>[]
): Promise<number> {
  return invoke<number>("delete_rows", {
    connId,
    database,
    table,
    primaryKeys,
  });
}

// ==================== SQL 编辑器 ====================

/**
 * 执行任意 SQL 语句。
 * @param executionId 可选执行令牌；传入后可用 {@link cancelQuery} 取消运行中的查询。
 */
export async function executeSql(
  connId: string,
  database: string | null,
  sql: string,
  executionId?: string
): Promise<SqlExecuteResult> {
  return invoke<SqlExecuteResult>("execute_sql", {
    connId,
    database,
    sql,
    executionId,
  });
}

/**
 * 取消（KILL QUERY）由 {@link executeSql} 以相同 executionId 登记的运行中查询。
 * @returns 是否成功发起取消（查询可能已结束则为 false）
 */
export async function cancelQuery(
  connId: string,
  executionId: string
): Promise<boolean> {
  return invoke<boolean>("cancel_query", { connId, executionId });
}

/**
 * 当前会话信息（版本、连接 ID、只读状态等）
 */
export async function getSessionInfo(
  connId: string,
  database: string | null
): Promise<SessionInfo> {
  return invoke<SessionInfo>("get_session_info", { connId, database });
}

/**
 * 当前会话信息（短时缓存 + 并发去重）
 */
export async function getSessionInfoCached(
  connId: string,
  database: string | null,
  options?: { force?: boolean; ttlMs?: number }
): Promise<SessionInfo> {
  const key = sessionInfoCacheKey(connId, database);
  const ttlMs = options?.ttlMs ?? SESSION_INFO_CACHE_TTL_MS;
  const now = Date.now();

  if (!options?.force) {
    const cached = sessionInfoCache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    const inflight = sessionInfoInflight.get(key);
    if (inflight) return inflight;
  }

  const req = getSessionInfo(connId, database)
    .then((info) => {
      sessionInfoCache.set(key, {
        value: info,
        expiresAt: Date.now() + Math.max(0, ttlMs),
      });
      return info;
    })
    .finally(() => {
      sessionInfoInflight.delete(key);
    });

  sessionInfoInflight.set(key, req);
  return req;
}

/** 失效会话信息缓存；传 connId 时仅清该连接 */
export function invalidateSessionInfoCache(connId?: string): void {
  if (!connId) {
    sessionInfoCache.clear();
    sessionInfoInflight.clear();
    return;
  }
  const prefix = `${connId}::`;
  for (const key of sessionInfoCache.keys()) {
    if (key.startsWith(prefix)) sessionInfoCache.delete(key);
  }
  for (const key of sessionInfoInflight.keys()) {
    if (key.startsWith(prefix)) sessionInfoInflight.delete(key);
  }
}

/**
 * 对 SQL 执行 EXPLAIN / EXPLAIN ANALYZE（行数上限与 execute_sql 一致）
 */
export async function explainSql(
  connId: string,
  database: string | null,
  sql: string,
  analyze: boolean
): Promise<SqlExecuteResult> {
  return invoke<SqlExecuteResult>("explain_sql", {
    connId,
    database,
    sql,
    analyze,
  });
}

/**
 * 读取本地 UTF-8 SQL 文件并预检高危语句，不执行任何 SQL。
 */
export async function previewSqlFileImport(
  databaseType: string | null | undefined,
  filePath: string
): Promise<PreviewSqlFileImportResult> {
  return invoke<PreviewSqlFileImportResult>("preview_sql_file_import", {
    databaseType,
    filePath,
  });
}

/**
 * 从本地 UTF-8 SQL 文件依次执行语句（当前连接与可选默认库）
 */
export async function importSqlFile(
  connId: string,
  database: string | null,
  filePath: string
): Promise<ImportSqlFileResult> {
  return invoke<ImportSqlFileResult>("import_sql_file", {
    connId,
    database,
    filePath,
  });
}

/**
 * 将整库导出为 .sql 文件（CREATE 表/视图；可选导出表数据 INSERT）
 */
export async function exportDatabaseToFile(
  connId: string,
  database: string,
  filePath: string,
  includeData: boolean,
  maxRowsPerTable: number
): Promise<ExportSqlFileResult> {
  return invoke<ExportSqlFileResult>("export_database_to_file", {
    connId,
    database,
    filePath,
    includeData,
    maxRowsPerTable,
  });
}
