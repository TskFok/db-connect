import { Button, Tooltip } from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";

/** 打开「功能介绍」弹窗的触发按钮（与 ThemeToggle 同款 text 样式） */
export function ProjectIntroTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip title="功能介绍">
      <Button
        type="text"
        size="small"
        icon={<QuestionCircleOutlined />}
        onClick={onOpen}
        aria-label="功能介绍"
        style={{ color: "var(--text-secondary)" }}
      />
    </Tooltip>
  );
}
