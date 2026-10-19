import { executeDatabaseSync as executeDatabaseSyncCommand } from "./tauriCommands";
import { useConnectionStore } from "../stores/connectionStore";
import type {
  DatabaseSyncExecutionResult,
  ExecuteDatabaseSyncRequest,
} from "../types";
import { invalidateSqlCompletion } from "../utils/sqlCompletionInvalidation";

/** 执行结构同步，并使当前已打开目标连接的元数据失效。 */
export async function executeDatabaseSync(
  input: ExecuteDatabaseSyncRequest
): Promise<DatabaseSyncExecutionResult> {
  const result = await executeDatabaseSyncCommand(input);
  if (result.completed_statements.length > 0) {
    // 同步使用临时连接；按保存配置定位当前已打开的目标连接。
    for (const connection of Object.values(
      useConnectionStore.getState().activeConnections
    )) {
      if (connection.config.id === input.request.target.saved_connection_id) {
        invalidateSqlCompletion({
          connId: connection.connId,
          database: input.request.target.database,
          reason: "schema-change",
        });
      }
    }
  }
  return result;
}
