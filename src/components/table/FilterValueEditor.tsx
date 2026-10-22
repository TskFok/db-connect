import { useId, useRef, useState } from "react";
import { Button, Modal, Space, Typography } from "antd";
import { EditOutlined } from "@ant-design/icons";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { SafeTextArea } from "../common/SafeInput";
import {
  TWO_VALUE_OPERATORS,
  type WhereFilterConfig,
} from "../../utils/whereFilterUtils";

interface FilterValueEditorProps {
  filter: WhereFilterConfig;
  onChange: (values: Pick<WhereFilterConfig, "value" | "value2">) => void;
}

export function FilterValueEditor({
  filter,
  onChange,
}: FilterValueEditorProps) {
  const [open, setOpen] = useState(false);
  const [draftValue, setDraftValue] = useState("");
  const [draftValue2, setDraftValue2] = useState("");
  const inputId = useId();
  const inputRef = useRef<TextAreaRef>(null);
  const needsTwoValues = TWO_VALUE_OPERATORS.includes(filter.operator);
  const preview = needsTwoValues
    ? `${filter.value || "起始值"} ~ ${filter.value2 || "结束值"}`
    : filter.value || "点击输入值";

  const openEditor = () => {
    setDraftValue(filter.value);
    setDraftValue2(filter.value2 ?? "");
    setOpen(true);
  };

  const confirmValue = () => {
    onChange(
      needsTwoValues
        ? { value: draftValue, value2: draftValue2 }
        : { value: draftValue }
    );
    setOpen(false);
  };

  return (
    <>
      <Button
        size="small"
        icon={<EditOutlined />}
        aria-label="编辑筛选值"
        title={preview}
        onClick={openEditor}
        style={{ width: 200, justifyContent: "flex-start" }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {preview}
        </span>
      </Button>
      <Modal
        title="编辑筛选值"
        open={open}
        onOk={confirmValue}
        onCancel={() => setOpen(false)}
        okText="确定"
        cancelText="取消"
        width={720}
        centered
        destroyOnHidden
        afterOpenChange={(visible) => {
          if (visible) inputRef.current?.focus({ cursor: "end" });
        }}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {filter.column || "未选择列"} {filter.operator}
          </Typography.Text>
          <div>
            <label
              htmlFor={inputId}
              style={{ display: "block", marginBottom: 8 }}
            >
              {needsTwoValues ? "起始值" : "值"}
            </label>
            <SafeTextArea
              id={inputId}
              ref={inputRef}
              value={draftValue}
              onChange={(event) => setDraftValue(event.target.value)}
              autoSize={{ minRows: needsTwoValues ? 4 : 8, maxRows: 16 }}
              style={{ fontFamily: "monospace" }}
              allowClear
            />
          </div>
          {needsTwoValues && (
            <div>
              <label
                htmlFor={`${inputId}-end`}
                style={{ display: "block", marginBottom: 8 }}
              >
                结束值
              </label>
              <SafeTextArea
                id={`${inputId}-end`}
                value={draftValue2}
                onChange={(event) => setDraftValue2(event.target.value)}
                autoSize={{ minRows: 4, maxRows: 16 }}
                style={{ fontFamily: "monospace" }}
                allowClear
              />
            </div>
          )}
          <Typography.Text type="secondary">
            {filter.operator === "IN"
              ? "多个值请使用英文逗号分隔，例如：1, 2, 3。"
              : needsTwoValues
                ? "请输入起始值和结束值。"
                : "字符串类型列可留空，表示匹配空字符串。"}
          </Typography.Text>
        </Space>
      </Modal>
    </>
  );
}
