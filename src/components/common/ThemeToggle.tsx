import { Button, Tooltip } from "antd";
import { SunOutlined, MoonOutlined } from "@ant-design/icons";
import { useThemeStore } from "../../stores/themeStore";

/**
 * 深色/浅色主题切换按钮
 */
export function ThemeToggle() {
  const { mode, toggleTheme } = useThemeStore();

  return (
    <Tooltip title={mode === "dark" ? "切换到浅色模式" : "切换到深色模式"}>
      <Button
        type="text"
        size="small"
        icon={mode === "dark" ? <SunOutlined /> : <MoonOutlined />}
        onClick={toggleTheme}
        style={{ color: "var(--text-secondary)" }}
      />
    </Tooltip>
  );
}
