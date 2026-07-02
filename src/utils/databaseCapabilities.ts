import type { DatabaseType } from "../types";
import { normalizeDatabaseType } from "./connectionConfig";

export interface DatabaseCapabilities {
  sqlEditor: boolean;
  /**
   * 是否允许「database/schema 级别」的可视化管理（创建/删除/重命名/编辑属性）。
   * MySQL 对应 database，PostgreSQL 对应 schema；具体名词由 `databaseObjectNoun` 给出。
   */
  databaseManagement: boolean;
  tableBrowsing: boolean;
  tableDataEditing: boolean;
  schemaManagement: boolean;
  routineManagement: boolean;
  /**
   * 是否展示定时事件（EVENT）管理。仅 MySQL 支持，PostgreSQL 无等价物。
   */
  eventManagement: boolean;
  triggerManagement: boolean;
  indexManagement: boolean;
  foreignKeyManagement: boolean;
  sqlFileImportExport: boolean;
  savedSql: boolean;
  favoriteTables: boolean;
  /**
   * 是否在 UI 中展示并允许编辑字符集/排序规则。MySQL 允许，PostgreSQL 在 schema 级别不存在该属性。
   */
  charsetAndCollation: boolean;
  /** 是否在 UI 中展示并允许编辑存储引擎。仅 MySQL。 */
  storageEngine: boolean;
  /**
   * 是否允许拖拽改列顺序。MySQL 支持 MODIFY ... AFTER；PostgreSQL 原生不支持改列顺序。
   */
  columnReordering: boolean;
  /**
   * UI 上的"数据库对象"名词，单数形式。MySQL → "数据库"，PostgreSQL → "schema"。
   * 用于按钮提示、Modal 标题等文案统一替换。
   */
  databaseObjectNoun: string;
}

const MYSQL_CAPABILITIES: DatabaseCapabilities = {
  sqlEditor: true,
  databaseManagement: true,
  tableBrowsing: true,
  tableDataEditing: true,
  schemaManagement: true,
  routineManagement: true,
  eventManagement: true,
  triggerManagement: true,
  indexManagement: true,
  foreignKeyManagement: true,
  sqlFileImportExport: true,
  savedSql: true,
  favoriteTables: true,
  charsetAndCollation: true,
  storageEngine: true,
  columnReordering: true,
  databaseObjectNoun: "数据库",
};

const POSTGRES_CAPABILITIES: DatabaseCapabilities = {
  sqlEditor: true,
  // 阶段四：PostgreSQL 支持 schema/table/column 管理（DDL），但语义为 schema 而非 database
  databaseManagement: true,
  tableBrowsing: true,
  tableDataEditing: true,
  schemaManagement: true,
  // 阶段五：PostgreSQL 支持函数/过程、触发器、索引、外键管理
  routineManagement: true,
  // PostgreSQL 无定时事件（EVENT）等价物，明确不展示
  eventManagement: false,
  triggerManagement: true,
  indexManagement: true,
  foreignKeyManagement: true,
  sqlFileImportExport: true,
  savedSql: false,
  favoriteTables: false,
  // PostgreSQL schema 级别不暴露字符集/排序规则；这些在 PG 是 database（cluster）级别
  charsetAndCollation: false,
  // PostgreSQL 无存储引擎概念
  storageEngine: false,
  // PostgreSQL ALTER COLUMN 不支持 FIRST/AFTER，原生无法重排列；
  // 在 UI 上禁用拖拽避免误以为可改，保留只读结构展示。
  columnReordering: false,
  databaseObjectNoun: "schema",
};

const SQLITE_CAPABILITIES: DatabaseCapabilities = {
  sqlEditor: true,
  databaseManagement: false,
  tableBrowsing: true,
  tableDataEditing: true,
  schemaManagement: true,
  routineManagement: false,
  eventManagement: false,
  triggerManagement: true,
  indexManagement: true,
  foreignKeyManagement: true,
  sqlFileImportExport: true,
  savedSql: true,
  favoriteTables: true,
  charsetAndCollation: false,
  storageEngine: false,
  columnReordering: false,
  databaseObjectNoun: "database",
};

const SQLSERVER_CAPABILITIES: DatabaseCapabilities = {
  sqlEditor: true,
  databaseManagement: true,
  tableBrowsing: true,
  tableDataEditing: true,
  schemaManagement: true,
  routineManagement: true,
  eventManagement: false,
  triggerManagement: true,
  indexManagement: true,
  foreignKeyManagement: true,
  sqlFileImportExport: true,
  savedSql: true,
  favoriteTables: true,
  charsetAndCollation: false,
  storageEngine: false,
  columnReordering: false,
  databaseObjectNoun: "schema",
};

export function getDatabaseCapabilities(
  databaseType: DatabaseType | string | null | undefined
): DatabaseCapabilities {
  const normalized = normalizeDatabaseType(databaseType);
  if (normalized === "postgres") return POSTGRES_CAPABILITIES;
  if (normalized === "sqlite") return SQLITE_CAPABILITIES;
  if (normalized === "sqlserver") return SQLSERVER_CAPABILITIES;
  return MYSQL_CAPABILITIES;
}
