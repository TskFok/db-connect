import { Alert, Space } from "antd";
import type { ComponentProps } from "react";
import { DataTaskPreviewView } from "./DataSyncPreview";
export function DataTransferPreview(
  props: ComponentProps<typeof DataTaskPreviewView>
) {
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Alert
        type="info"
        message="传输使用已读取的准确源行数；只复制数据，不删除源端。字段映射和无损类型转换已由后端预检。"
      />
      <DataTaskPreviewView {...props} showDiff={false} />
    </Space>
  );
}
