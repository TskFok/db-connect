import type { AddForeignKeyRequest } from "../types";
import type { DatabaseType } from "../types";

type ForeignKeySqlDialect = Extract<
  DatabaseType,
  "mysql" | "postgres" | "sqlite" | "sqlserver"
>;

function escId(name: string, dialect: ForeignKeySqlDialect = "mysql"): string {
  if (dialect === "sqlserver") {
    return `[${name.replace(/]/g, "]]")}]`;
  }
  return `\`${name.replace(/`/g, "``")}\``;
}

/** 解析 `table` 或 `schema.table`，返回 [schema, table] */
export function parseReferencedTable(
  defaultSchema: string,
  name: string
): [string, string] {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("被引用表不能为空");
  }
  const dot = trimmed.lastIndexOf(".");
  if (dot === -1) {
    return [defaultSchema, trimmed];
  }
  const a = trimmed.slice(0, dot).trim();
  const b = trimmed.slice(dot + 1).trim();
  if (!a || !b) {
    throw new Error("被引用表限定名格式无效");
  }
  return [a, b];
}

const ALLOWED_ACTIONS = new Set([
  "RESTRICT",
  "CASCADE",
  "SET NULL",
  "NO ACTION",
  "SET DEFAULT",
]);

const SQLSERVER_ALLOWED_ACTIONS = new Set([
  "CASCADE",
  "SET NULL",
  "NO ACTION",
  "SET DEFAULT",
]);

export function validateReferentialAction(
  rule: string,
  dialect: ForeignKeySqlDialect = "mysql"
): void {
  const u = rule.trim().toUpperCase();
  if (dialect === "sqlserver") {
    if (!SQLSERVER_ALLOWED_ACTIONS.has(u)) {
      throw new Error(
        `SQL Server 外键引用动作不支持 ${rule}（允许 NO ACTION、CASCADE、SET NULL、SET DEFAULT）`
      );
    }
    return;
  }
  if (!ALLOWED_ACTIONS.has(u)) {
    throw new Error(
      `无效的引用动作: ${rule}（允许 RESTRICT、CASCADE、SET NULL、NO ACTION、SET DEFAULT）`
    );
  }
}

/**
 * 与后端 `build_add_foreign_key_sql` 一致的预览 DDL（用于向导确认）
 */
export function previewAddForeignKeySql(
  database: string,
  table: string,
  request: AddForeignKeyRequest,
  dialect: ForeignKeySqlDialect = "mysql"
): string {
  const cname = request.constraint_name.trim();
  if (!cname) {
    throw new Error("约束名不能为空");
  }
  if (!request.columns.length) {
    throw new Error("至少需要一列本地列");
  }
  if (request.referenced_columns.length !== request.columns.length) {
    throw new Error("本地列与引用列数量必须一致");
  }
  validateReferentialAction(request.on_update, dialect);
  validateReferentialAction(request.on_delete, dialect);

  const [refSchema, refTbl] = parseReferencedTable(
    database,
    request.referenced_table
  );
  if (
    dialect === "sqlserver" &&
    request.referenced_table.split(".").length > 2
  ) {
    throw new Error("SQL Server 外键暂不支持跨 database 引用");
  }

  const fkCols = request.columns
    .map((c) => escId(c.trim(), dialect))
    .join(", ");
  const refCols = request.referenced_columns
    .map((c) => escId(c.trim(), dialect))
    .join(", ");
  const onUp = request.on_update.trim().toUpperCase();
  const onDel = request.on_delete.trim().toUpperCase();

  return `ALTER TABLE ${escId(database, dialect)}.${escId(
    table,
    dialect
  )} ADD CONSTRAINT ${escId(cname, dialect)} FOREIGN KEY (${fkCols}) REFERENCES ${escId(
    refSchema,
    dialect
  )}.${escId(refTbl, dialect)} (${refCols}) ON UPDATE ${onUp} ON DELETE ${onDel}`;
}
