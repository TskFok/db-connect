import type { SqlDialect, SqlSchema } from "./sqlCompletion";
import type {
  SqlCompletionCacheKey,
  SqlMetadataIndex,
} from "./sqlCompletionTypes";
import {
  getSqlCompletionSystemNamespaces,
  getSqlCompletionSystemSchema,
} from "./sqlCompletionSystemSchema";

const systemIndexes = new WeakMap<SqlMetadataIndex, SqlMetadataIndex>();

/** Catalog 名称保持原样；大小写绑定在查询时完成，避免覆盖同名对象。 */
export function buildSqlMetadataIndex(
  schema: SqlSchema,
  key: SqlCompletionCacheKey
): SqlMetadataIndex {
  let incompleteTables: Set<string> | undefined;
  const systemSchema = getSqlCompletionSystemSchema(key.dialect, key.database);
  if (systemSchema) {
    // 以表为边界使用真实快照，避免把版本不支持的静态列补回真实表中。
    const known = new Set(
      schema.tables.map((table) => table.name.toLowerCase())
    );
    const missing = systemSchema.tables.filter(
      (table) => !known.has(table.name.toLowerCase())
    );
    const fallback = new Set(missing.map((table) => table.name));
    incompleteTables = fallback;
    schema = {
      databases: schema.databases,
      tables: [...schema.tables, ...missing],
      columns: [
        ...schema.columns,
        ...systemSchema.columns.filter((column) => fallback.has(column.table)),
      ],
    };
  }
  const tablesByName = new Map(
    schema.tables.map((table) => [table.name, table])
  );
  const columnsByTable: SqlMetadataIndex["columnsByTable"] = new Map();
  for (const column of schema.columns) {
    const columns = columnsByTable.get(column.table) ?? [];
    columns.push(column);
    columnsByTable.set(column.table, columns);
  }
  return {
    key,
    schema,
    tablesByName,
    columnsByTable,
    ...(incompleteTables?.size ? { incompleteTables } : {}),
  };
}

/** 仅当前库和内置系统库可用；未知跨库引用不回退业务元数据。 */
export function getSqlMetadataIndexForNamespace(
  index: SqlMetadataIndex,
  namespace: string | null | undefined,
  quoted = false
): SqlMetadataIndex | undefined {
  if (
    namespace == null ||
    (index.key.database !== null &&
      resolveSqlName(
        namespace,
        quoted,
        [index.key.database],
        index.key.dialect
      ) !== undefined)
  )
    return index;
  const schema = getSqlCompletionSystemSchema(index.key.dialect, namespace);
  if (!schema) return undefined;
  let systemIndex = systemIndexes.get(index);
  if (!systemIndex) {
    systemIndex = buildSqlMetadataIndex(
      { databases: schema.databases, tables: [], columns: [] },
      { ...index.key, database: schema.databases[0] }
    );
    systemIndexes.set(index, systemIndex);
  }
  return systemIndex;
}

/** 合并系统库时保留 catalog 原名，并按当前方言消除重复名称。 */
export function getSqlMetadataNamespaces(index: SqlMetadataIndex): string[] {
  const namespaces = [...new Set(index.schema.databases)];
  for (const namespace of getSqlCompletionSystemNamespaces(index.key.dialect)) {
    if (
      resolveSqlName(namespace, false, namespaces, index.key.dialect) ===
      undefined
    )
      namespaces.push(namespace);
  }
  return namespaces;
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
