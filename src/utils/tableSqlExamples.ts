import type { ColumnInfo, DatabaseType } from "../types";
import { escapeIdentifierForDialect } from "./sqlUtils";

export interface TableSqlExample {
  id: string;
  title: string;
  description: string;
  sql: string;
}

function isAutomaticallyGenerated(
  column: ColumnInfo,
  dialect: DatabaseType
): boolean {
  // DEFAULT_GENERATED 是 MySQL 的普通默认值标记，不代表不可写的生成列。
  if (/\b(auto_increment|identity|generated)\b/i.test(column.extra)) {
    return true;
  }
  if (dialect === "postgres") {
    return /^\s*nextval\s*\(/i.test(column.default_value ?? "");
  }
  if (dialect === "sqlserver") {
    return (
      /^computed\b/i.test(column.extra.trim()) ||
      /^(rowversion|timestamp)$/i.test(column.column_type.trim())
    );
  }
  if (dialect === "clickhouse") {
    return /^\s*(MATERIALIZED|ALIAS)\b/i.test(column.default_value ?? "");
  }
  return false;
}

export function buildTableSqlExamples({
  database,
  table,
  columns,
  dialect,
  isView = false,
}: {
  database: string;
  table: string;
  columns: ColumnInfo[];
  dialect: DatabaseType;
  isView?: boolean;
}): TableSqlExample[] {
  // ClickHouse 在引用标识符中仍解析反斜杠转义，与后端方言保持一致。
  const quote = (name: string) =>
    escapeIdentifierForDialect(
      dialect === "clickhouse" ? name.replace(/\\/g, "\\\\") : name,
      dialect
    );
  const tableReference = `${quote(database)}.${quote(table)}`;
  const select = `${dialect === "sqlserver" ? "SELECT TOP (100) *" : "SELECT *"}\nFROM ${tableReference}`;
  const limit = dialect === "sqlserver" ? ";" : "\nLIMIT 100;";
  const primaryColumns = columns.filter((column) => column.key === "PRI");
  // SQL Server 后端只将一个选定的非过滤唯一索引的全部列标为 UNI。
  const uniqueColumns =
    dialect === "sqlserver"
      ? columns.filter((column) => column.key === "UNI")
      : [];
  const conditionColumns = primaryColumns.length
    ? primaryColumns
    : uniqueColumns.length
      ? uniqueColumns
      : columns.slice(0, 1);
  const where = conditionColumns
    .map((column, index) => `${quote(column.name)} = <条件值${index + 1}>`)
    .join(" AND ");
  const conditionDescription = primaryColumns.length
    ? "按主键筛选，替换条件值后使用。"
    : uniqueColumns.length
      ? "按唯一索引筛选，替换条件值后使用。"
      : "以首列作为条件示例，请按实际需求调整筛选条件。";
  const examples: TableSqlExample[] = [
    {
      id: "select",
      title: "查询数据",
      description: "查看最多 100 行数据。",
      sql: `${select}${limit}`,
    },
  ];

  if (where) {
    examples.push({
      id: "filter",
      title: "按条件查询",
      description: conditionDescription,
      sql: `${select}\nWHERE ${where}${limit}`,
    });
  }
  examples.push({
    id: "count",
    title: "统计行数",
    description: "统计全部数据的行数。",
    sql: `SELECT COUNT(*) AS total\nFROM ${tableReference};`,
  });

  if (isView) return examples;

  const writableColumns = columns.filter(
    (column) => !isAutomaticallyGenerated(column, dialect)
  );
  if (writableColumns.length) {
    examples.push({
      id: "insert",
      title: "插入数据",
      description: "填写字段值新增一行，已排除明确标记的自增和生成列。",
      sql: `INSERT INTO ${tableReference} (${writableColumns.map((column) => quote(column.name)).join(", ")})\nVALUES (${writableColumns.map((_, index) => `<值${index + 1}>`).join(", ")});`,
    });
  }

  if (dialect === "clickhouse") return examples;

  const updateColumns = writableColumns.filter(
    (column) => column.key !== "PRI"
  );
  if (where && updateColumns.length) {
    const assignments = updateColumns
      .map((column, index) => `${quote(column.name)} = <新值${index + 1}>`)
      .join(",\n    ");
    examples.push({
      id: "update",
      title: "更新数据",
      description: `修改符合条件的行。${conditionDescription}`,
      sql: `UPDATE ${tableReference}\nSET ${assignments}\nWHERE ${where};`,
    });
  }
  if (where) {
    examples.push({
      id: "delete",
      title: "删除数据",
      description: `删除符合条件的行。${conditionDescription}`,
      sql: `DELETE FROM ${tableReference}\nWHERE ${where};`,
    });
  }
  return examples;
}
