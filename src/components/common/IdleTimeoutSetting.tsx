import { Select, Tooltip } from "antd";
import { ClockCircleOutlined } from "@ant-design/icons";
import {
  useSettingsStore,
  IDLE_TIMEOUT_OPTIONS,
} from "../../stores/settingsStore";

/**
 * 空闲超时断开设置，减少凭据驻留时间
 */
export function IdleTimeoutSetting() {
  const { idleTimeoutMinutes, setIdleTimeoutMinutes } = useSettingsStore();

  return (
    <Tooltip title="长时间空闲后自动断开连接，减少凭据在内存中的驻留时间">
      <Select
        value={idleTimeoutMinutes}
        onChange={setIdleTimeoutMinutes}
        options={IDLE_TIMEOUT_OPTIONS.map((opt) => ({
          value: opt.value,
          label: opt.label,
        }))}
        suffixIcon={<ClockCircleOutlined style={{ fontSize: 12 }} />}
        style={{ width: 100, fontSize: 12 }}
        size="small"
        variant="borderless"
      />
    </Tooltip>
  );
}
