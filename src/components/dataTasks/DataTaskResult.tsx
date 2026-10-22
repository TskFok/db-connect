import { Alert, Card, Space } from "antd";
import type { DataTaskResult as TaskResult } from "../../types/dataTasks";
import {
  describeDataTaskProgress,
  formatDataCount,
} from "../../utils/dataTaskProgress";
export function DataTaskResult({ result }: { result: TaskResult }) {
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Alert
        showIcon
        type={
          result.commit_state === "committed"
            ? "success"
            : result.commit_state === "unknown" ||
                result.commit_state === "partial"
              ? "warning"
              : "info"
        }
        message={describeDataTaskProgress(result.status)}
        description={
          result.commit_state === "rolled_back"
            ? "目标业务表数据已回滚；序列或自增计数可能存在间隙。"
            : result.commit_state === "unknown"
              ? "请核对目标数据和数据库提交状态，不要直接重复执行。"
              : result.error?.message
        }
      />
      {result.tables.map((table) => (
        <Card key={table.table_id} size="small" title={table.target_table}>
          已写入 {formatDataCount(table.counts.written)} 行，已验证{" "}
          {formatDataCount(table.counts.verified)} 行
        </Card>
      ))}
      {result.cleanup_errors.map((error, i) => (
        <Alert
          key={i}
          type="warning"
          message={`数据文件或连接清理失败：${error}`}
        />
      ))}
    </Space>
  );
}
