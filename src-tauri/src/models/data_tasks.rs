use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DataEndpoint {
    pub saved_connection_id: String,
    pub database: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataTaskKind {
    RowSync,
    Transfer,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataTaskMode {
    Merge,
    Mirror,
    Append,
    Replace,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ColumnMapping {
    pub source_column: String,
    pub target_column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TableMapping {
    pub source_table: String,
    pub target_table: String,
    pub columns: Vec<ColumnMapping>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DataTaskRequest {
    pub protocol_version: u32,
    pub kind: DataTaskKind,
    pub source: DataEndpoint,
    pub target: DataEndpoint,
    pub mappings: Vec<TableMapping>,
    pub mode: DataTaskMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataTaskError {
    pub code: String,
    pub message: String,
}

impl DataTaskError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl std::fmt::Display for DataTaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for DataTaskError {}

impl DataTaskRequest {
    pub fn validate(&self) -> Result<(), DataTaskError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(DataTaskError::new(
                "unsupported_capability",
                "数据任务协议版本不受支持",
            ));
        }
        if !matches!(
            (self.kind, self.mode),
            (
                DataTaskKind::RowSync,
                DataTaskMode::Merge | DataTaskMode::Mirror
            ) | (
                DataTaskKind::Transfer,
                DataTaskMode::Append | DataTaskMode::Replace
            )
        ) {
            return Err(DataTaskError::new(
                "unsupported_capability",
                "任务类型与模式不匹配",
            ));
        }
        if self.source.saved_connection_id.trim().is_empty()
            || self.target.saved_connection_id.trim().is_empty()
            || self.source.database.trim().is_empty()
            || self.target.database.trim().is_empty()
            || self.mappings.is_empty()
            || self.mappings.len() > 100
        {
            return Err(DataTaskError::new(
                "invalid_mapping",
                "请选择有效端点及 1 至 100 张表",
            ));
        }
        let mut targets = std::collections::HashSet::new();
        for table in &self.mappings {
            if table.source_table.is_empty()
                || table.target_table.is_empty()
                || table.columns.is_empty()
                || !targets.insert(&table.target_table)
            {
                return Err(DataTaskError::new(
                    "invalid_mapping",
                    "表映射为空或目标表重复",
                ));
            }
            let mut sources = std::collections::HashSet::new();
            let mut columns = std::collections::HashSet::new();
            for column in &table.columns {
                if column.source_column.is_empty()
                    || column.target_column.is_empty()
                    || !sources.insert(&column.source_column)
                    || !columns.insert(&column.target_column)
                {
                    return Err(DataTaskError::new(
                        "invalid_mapping",
                        "字段映射必须是一对一且非空",
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataTaskBlocker {
    pub code: String,
    pub message: String,
    pub table: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataTaskCapabilities {
    pub row_sync: bool,
    pub transfer: bool,
    pub supported_modes: Vec<DataTaskMode>,
    pub blockers: Vec<DataTaskBlocker>,
    pub source_tables: Vec<DataTaskObject>,
    pub target_tables: Vec<DataTaskObject>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataTaskObject {
    pub table: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataTaskRisk {
    pub id: String,
    pub message: String,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataTaskCounts {
    pub source_rows: String,
    pub target_rows: String,
    pub inserted: String,
    pub updated: String,
    pub deleted: String,
    pub unchanged: String,
    pub retained: String,
    pub written: String,
    pub verified: String,
}
impl Default for DataTaskCounts {
    fn default() -> Self {
        Self {
            source_rows: "0".into(),
            target_rows: "0".into(),
            inserted: "0".into(),
            updated: "0".into(),
            deleted: "0".into(),
            unchanged: "0".into(),
            retained: "0".into(),
            written: "0".into(),
            verified: "0".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataTablePreview {
    pub table_id: String,
    pub source_table: String,
    pub target_table: String,
    pub counts: DataTaskCounts,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataTaskPreview {
    pub task_id: String,
    pub plan_id: String,
    pub fingerprint: String,
    pub source: DataEndpoint,
    pub target: DataEndpoint,
    pub kind: DataTaskKind,
    pub mode: DataTaskMode,
    pub tables: Vec<DataTablePreview>,
    pub source_captured_at: String,
    pub target_captured_at: String,
    pub expires_at: String,
    pub risks: Vec<DataTaskRisk>,
    pub blockers: Vec<DataTaskBlocker>,
    pub can_execute: bool,
    pub sql_examples: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataDiffOperation {
    Insert,
    Update,
    Delete,
    Retain,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataValuePreview {
    pub value_type: String,
    pub display: String,
    pub original_bytes: String,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataColumnDiff {
    pub column: String,
    pub old: Option<DataValuePreview>,
    pub new: Option<DataValuePreview>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataDiffItem {
    pub operation: DataDiffOperation,
    pub key: Vec<DataValuePreview>,
    pub changes: Vec<DataColumnDiff>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataDiffPage {
    pub plan_id: String,
    pub table_id: String,
    pub items: Vec<DataDiffItem>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExecuteDataTaskInput {
    pub plan_id: String,
    pub fingerprint: String,
    pub execution_id: String,
    pub accepted_risk_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataTaskStatus {
    Created,
    Validating,
    Reading,
    Comparing,
    Ready,
    Executing,
    Verifying,
    Committing,
    Cancelling,
    Succeeded,
    Failed,
    Cancelled,
    Expired,
    Interrupted,
    OutcomeUnknown,
    Partial,
}
impl DataTaskStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded
                | Self::Failed
                | Self::Cancelled
                | Self::Expired
                | Self::Interrupted
                | Self::OutcomeUnknown
                | Self::Partial
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataCommitState {
    None,
    Committed,
    RolledBack,
    Unknown,
    Partial,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataTaskResult {
    pub status: DataTaskStatus,
    pub commit_state: DataCommitState,
    pub tables: Vec<DataTablePreview>,
    pub error: Option<DataTaskError>,
    pub cleanup_errors: Vec<String>,
    pub requires_target_refresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataTaskSnapshot {
    pub task_id: String,
    pub execution_id: Option<String>,
    pub sequence: String,
    pub status: DataTaskStatus,
    pub request: DataTaskRequest,
    pub created_at: String,
    pub updated_at: String,
    pub read_rows: String,
    pub written_rows: String,
    pub verified_rows: String,
    pub bytes: String,
    pub elapsed_ms: String,
    pub preview: Option<DataTaskPreview>,
    pub result: Option<DataTaskResult>,
}
