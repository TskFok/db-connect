import type { AddForeignKeyRequest } from "../types";

function escId(name: string): string {
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

export function validateReferentialAction(rule: string): void {
  const u = rule.trim().toUpperCase();
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
  request: AddForeignKeyRequest
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
  validateReferentialAction(request.on_update);
  validateReferentialAction(request.on_delete);

  const [refSchema, refTbl] = parseReferencedTable(
    database,
    request.referenced_table
  );

  const fkCols = request.columns.map((c) => escId(c.trim())).join(", ");
  const refCols = request.referenced_columns
    .map((c) => escId(c.trim()))
    .join(", ");
  const onUp = request.on_update.trim().toUpperCase();
  const onDel = request.on_delete.trim().toUpperCase();

  return `ALTER TABLE ${escId(database)}.${escId(
    table
  )} ADD CONSTRAINT ${escId(cname)} FOREIGN KEY (${fkCols}) REFERENCES ${escId(
    refSchema
  )}.${escId(refTbl)} (${refCols}) ON UPDATE ${onUp} ON DELETE ${onDel}`;
}
