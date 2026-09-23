import type { SqlSchema } from "../../utils/sqlCompletion";
import type { SqlCompletionCacheKey } from "../../utils/sqlCompletionTypes";

export const completionSchema: SqlSchema = {
  databases: ["app"],
  tables: [{ name: "users" }, { name: "orders" }],
  columns: [
    { table: "users", name: "id", type: "int" },
    { table: "users", name: "name", type: "varchar" },
    { table: "orders", name: "id", type: "int" },
    { table: "orders", name: "user_id", type: "int" },
  ],
};
export const completionKey: SqlCompletionCacheKey = {
  connId: "conn-1",
  database: "app",
  dialect: "mysql",
  connectionRevision: 0,
};
