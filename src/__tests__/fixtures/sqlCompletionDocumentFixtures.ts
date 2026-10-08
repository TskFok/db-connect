import type { SqlSchema } from "../../utils/sqlCompletion";

export const activeSql = "SELECT t.column_0 FROM table_500 AS t WHERE t.col";
export const historicalSql =
  "SELECT id, name FROM historical_table WHERE id = 42;\n";
export const documentSizes = [49, 100 * 1024, 1024 * 1024];

export function completionDocument(size: number): string {
  const count = Math.floor((size - activeSql.length) / historicalSql.length);
  return (
    historicalSql.repeat(count).padEnd(size - activeSql.length, " ") + activeSql
  );
}

export function completionLargeSchema(): SqlSchema {
  const tables = Array.from({ length: 1_000 }, (_, i) => ({
    name: `table_${i}`,
  }));
  return {
    databases: ["app"],
    tables,
    columns: tables.flatMap((table) =>
      Array.from({ length: 50 }, (_, i) => ({
        table: table.name,
        name: `column_${i}`,
        type: "int",
      }))
    ),
  };
}
