import { Button, message, Space } from "antd";
import { open, type DialogFilter } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import type { InputProps } from "antd/es/input";
import { SafeInput } from "./SafeInput";

interface FilePathInputProps extends Omit<
  InputProps,
  "addonAfter" | "onChange" | "value"
> {
  value?: string;
  onChange?: (value: string) => void;
  dialogTitle: string;
  buttonLabel: string;
  filters?: DialogFilter[];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function FilePathInput({
  value,
  onChange,
  dialogTitle,
  buttonLabel,
  filters,
  style,
  ...inputProps
}: FilePathInputProps) {
  const [selecting, setSelecting] = useState(false);

  const handleSelect = async () => {
    setSelecting(true);
    try {
      const chosen = await open({
        title: dialogTitle,
        multiple: false,
        directory: false,
        ...(filters ? { filters } : {}),
      });
      const path = Array.isArray(chosen) ? chosen[0] : chosen;
      if (typeof path === "string" && path) {
        onChange?.(path);
      }
    } catch (error) {
      message.error(
        <span role="alert">
          {dialogTitle}失败：{getErrorMessage(error)}
        </span>
      );
    } finally {
      setSelecting(false);
    }
  };

  return (
    <Space.Compact block>
      <SafeInput
        {...inputProps}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        style={{ ...style, flex: 1 }}
      />
      <Button
        type="default"
        aria-label={buttonLabel}
        loading={selecting}
        onClick={handleSelect}
      >
        选择文件
      </Button>
    </Space.Compact>
  );
}
