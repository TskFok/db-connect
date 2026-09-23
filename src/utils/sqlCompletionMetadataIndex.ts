import type { SqlDialect, SqlSchema } from "./sqlCompletion";
import type {
  SqlCompletionCacheKey,
  SqlMetadataIndex,
} from "./sqlCompletionTypes";

/** Catalog 名称保持原样；大小写绑定在查询时完成，避免覆盖同名对象。 */
export function buildSqlMetadataIndex(
  schema: SqlSchema,
  key: SqlCompletionCacheKey
): SqlMetadataIndex {
  const tablesByName = new Map(
    schema.tables.map((table) => [table.name, table])
  );
  const columnsByTable: SqlMetadataIndex["columnsByTable"] = new Map();
  for (const column of schema.columns) {
    const columns = columnsByTable.get(column.table) ?? [];
    columns.push(column);
    columnsByTable.set(column.table, columns);
  }
  return { key, schema, tablesByName, columnsByTable };
}

/** PostgreSQL 非引用标识符仅对已知 ASCII 大写字符进行折叠。 */
export function sqlIdentifierName(
  name: string,
  quoted: boolean,
  dialect: SqlDialect
): string {
  return dialect === "postgres" && !quoted
    ? name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    : name;
}

/** 大小写规则未知时只采用唯一回退，绝不合并不同 catalog 对象。 */
export function resolveSqlName(
  name: string,
  quoted: boolean,
  names: readonly string[],
  dialect: SqlDialect
): string | undefined {
  const actual = sqlIdentifierName(name, quoted, dialect);
  const exact = names.filter((candidate) => candidate === actual);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1 || dialect === "postgres" || dialect === "clickhouse")
    return undefined;
  const folded = actual.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const matches = names.filter(
    (candidate) =>
      candidate.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) === folded
  );
  return matches.length === 1 ? matches[0] : undefined;
}
