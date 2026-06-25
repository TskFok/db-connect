import type { DatabaseType, SqlCompletionMetadata } from "../types";
import type { SqlDialect, SqlSchema } from "./sqlCompletion";

export interface SqlCompletionMetadataSource {
  getSqlCompletionMetadata(
    connId: string,
    database: string | null
  ): Promise<SqlCompletionMetadata>;
}

export async function loadSqlCompletionSchema(
  source: SqlCompletionMetadataSource,
  connId: string,
  database: string | null,
  _dialect: SqlDialect | DatabaseType
): Promise<SqlSchema> {
  if (!connId) {
    return { databases: [], tables: [], columns: [] };
  }

  const metadata = await source.getSqlCompletionMetadata(connId, database);
  return {
    databases: metadata.databases,
    tables: metadata.tables.map((table) => ({ name: table.name })),
    columns: metadata.columns.map((column) => ({
      table: column.table,
      name: column.name,
      type: column.type ?? undefined,
    })),
  };
}
