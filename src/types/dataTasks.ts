/** 与 Rust models/data_tasks.rs 对齐；所有计数和时间戳保持十进制字符串。 */
export type DataTaskKind = "row_sync" | "transfer";
export type DataTaskMode = "merge" | "mirror" | "append" | "replace";
export type DataTaskStatus =
  | "created"
  | "validating"
  | "reading"
  | "comparing"
  | "ready"
  | "executing"
  | "verifying"
  | "committing"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "interrupted"
  | "outcome_unknown"
  | "partial";
export interface DataEndpoint {
  saved_connection_id: string;
  database: string;
}
export interface ColumnMapping {
  source_column: string;
  target_column: string;
}
export interface TableMapping {
  source_table: string;
  target_table: string;
  columns: ColumnMapping[];
}
export interface DataTaskRequest {
  protocol_version: 1;
  kind: DataTaskKind;
  source: DataEndpoint;
  target: DataEndpoint;
  mappings: TableMapping[];
  mode: DataTaskMode;
}
export interface DataTaskError {
  code: string;
  message: string;
}
export interface DataTaskBlocker extends DataTaskError {
  table: string | null;
}
export interface DataTaskObject {
  table: string;
  columns: string[];
}
export interface DataTaskCapabilities {
  source_tables: DataTaskObject[];
  target_tables: DataTaskObject[];
  row_sync: boolean;
  transfer: boolean;
  supported_modes: DataTaskMode[];
  blockers: DataTaskBlocker[];
}
export interface DataTaskRisk {
  id: string;
  message: string;
  required: boolean;
}
export interface DataTaskCounts {
  source_rows: string;
  target_rows: string;
  inserted: string;
  updated: string;
  deleted: string;
  unchanged: string;
  retained: string;
  written: string;
  verified: string;
}
export interface DataTablePreview {
  table_id: string;
  source_table: string;
  target_table: string;
  counts: DataTaskCounts;
}
export interface DataTaskPreview {
  task_id: string;
  plan_id: string;
  fingerprint: string;
  source: DataEndpoint;
  target: DataEndpoint;
  kind: DataTaskKind;
  mode: DataTaskMode;
  tables: DataTablePreview[];
  source_captured_at: string;
  target_captured_at: string;
  expires_at: string;
  risks: DataTaskRisk[];
  blockers: DataTaskBlocker[];
  can_execute: boolean;
  sql_examples: string[];
}
export interface DataValuePreview {
  value_type: string;
  display: string;
  original_bytes: string;
  truncated: boolean;
}
export interface DataColumnDiff {
  column: string;
  old: DataValuePreview | null;
  new: DataValuePreview | null;
}
export interface DataDiffItem {
  operation: "insert" | "update" | "delete" | "retain";
  key: DataValuePreview[];
  changes: DataColumnDiff[];
}
export interface DataDiffPage {
  plan_id: string;
  table_id: string;
  items: DataDiffItem[];
  next_cursor: string | null;
}
export interface ExecuteDataTaskInput {
  plan_id: string;
  fingerprint: string;
  execution_id: string;
  accepted_risk_ids: string[];
}
export interface DataTaskResult {
  status: DataTaskStatus;
  commit_state: "none" | "committed" | "rolled_back" | "unknown" | "partial";
  tables: DataTablePreview[];
  error: DataTaskError | null;
  cleanup_errors: string[];
  requires_target_refresh: boolean;
}
export interface DataTaskSnapshot {
  task_id: string;
  execution_id: string | null;
  sequence: string;
  status: DataTaskStatus;
  request: DataTaskRequest;
  created_at: string;
  updated_at: string;
  read_rows: string;
  written_rows: string;
  verified_rows: string;
  bytes: string;
  elapsed_ms: string;
  preview: DataTaskPreview | null;
  result: DataTaskResult | null;
}
export interface DataTaskSeed {
  source?: DataEndpoint;
  tables?: string[];
}
