import { Modal, Typography } from "antd";

const { Text } = Typography;

interface ShortcutsHelpModalProps {
  open: boolean;
  onClose: () => void;
}

/** 判断当前是否 macOS */
const isMac = typeof navigator !== "undefined" && navigator.platform.includes("Mac");
const modKey = isMac ? "⌘" : "Ctrl";

interface ShortcutItem {
  keys: string[];
  description: string;
}

const shortcuts: ShortcutItem[] = [
  { keys: [modKey, "N"], description: "新建连接" },
  { keys: [modKey, "R"], description: "刷新数据" },
  { keys: [modKey, "Shift", "R"], description: "刷新分页（重新统计总行数）" },
  { keys: [modKey, "D"], description: "断开连接" },
  { keys: [modKey, "F"], description: "搜索表" },
  { keys: [modKey, "L"], description: "切换深色/浅色主题" },
  { keys: [modKey, "Enter"], description: "执行 SQL (在 SQL 编辑器中)" },
  { keys: [modKey, "/"], description: "显示/隐藏快捷键帮助" },
  {
    keys: ["Shift", "点击已打开的表/标签页"],
    description: "关闭该表标签页",
  },
  { keys: ["Esc"], description: "关闭弹窗" },
];

/**
 * 快捷键帮助弹窗
 */
export function ShortcutsHelpModal({ open, onClose }: ShortcutsHelpModalProps) {
  return (
    <Modal
      title="键盘快捷键"
      open={open}
      onCancel={onClose}
      footer={null}
      width={420}
      centered
    >
      <div style={{ padding: "8px 0" }}>
        {shortcuts.map((s, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 0",
              borderBottom:
                i < shortcuts.length - 1
                  ? "1px solid var(--border-color)"
                  : "none",
            }}
          >
            <Text>{s.description}</Text>
            <div style={{ display: "flex", gap: 4 }}>
              {s.keys.map((key, ki) => (
                <span key={ki}>
                  {ki > 0 && (
                    <span
                      style={{
                        margin: "0 2px",
                        color: "var(--text-muted)",
                        fontSize: 11,
                      }}
                    >
                      +
                    </span>
                  )}
                  <span className="shortcut-key">{key}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
