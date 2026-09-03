import { Select, Tooltip } from "antd";
import { ExpandOutlined } from "@ant-design/icons";
import {
  useSettingsStore,
  WINDOW_LAUNCH_OPTIONS,
} from "../../stores/settingsStore";

/**
 * 启动窗口行为：每次最大化，或记住上次大小/位置
 */
export function WindowLaunchSetting() {
  const { windowLaunchMode, setWindowLaunchMode } = useSettingsStore();

  return (
    <Tooltip title="启动时最大化窗口，或恢复上次关闭时的大小和位置">
      <Select
        aria-label="窗口启动方式"
        value={windowLaunchMode}
        onChange={setWindowLaunchMode}
        options={WINDOW_LAUNCH_OPTIONS.map((opt) => ({
          value: opt.value,
          label: opt.label,
        }))}
        suffixIcon={<ExpandOutlined style={{ fontSize: 12 }} />}
        style={{ width: 148, fontSize: 12 }}
        size="small"
        variant="borderless"
      />
    </Tooltip>
  );
}
