import { useState } from "react";
import { Button, DatePicker, TimePicker } from "antd";
import type { Dayjs } from "dayjs";
import { SafeInput } from "../common/SafeInput";
import {
  formatTemporalValue,
  parseTemporalValue,
  TEMPORAL_FORMATS,
  type TemporalKind,
} from "../../utils/temporalValue";

interface TemporalInputProps {
  kind: TemporalKind;
  value?: string | null;
  onChange?: (value: string) => void;
  id?: string;
  label?: string;
  placeholder?: string;
  size?: "small" | "middle" | "large";
  autoFocus?: boolean;
}

/** 表单中始终保存数据库字符串，选择器只负责选择日期/时间。 */
export function TemporalInput({
  kind,
  value,
  onChange,
  id,
  label,
  placeholder,
  size,
  autoFocus,
}: TemporalInputProps) {
  const text = value ?? "";
  const parsed = parseTemporalValue(text, kind);
  const [manual, setManual] = useState(() => Boolean(text && !parsed));
  const pickerProps = {
    id,
    "aria-label": label,
    value: parsed,
    onChange: (date: Dayjs | null) =>
      onChange?.(date ? formatTemporalValue(date, kind, text) : ""),
    // 保留精度/时区后缀供核对；不能由面板表达的部分可切换到手动输入。
    format: (date: Dayjs) => formatTemporalValue(date, kind, text),
    placeholder: placeholder ?? TEMPORAL_FORMATS[kind],
    size,
    autoFocus,
    inputReadOnly: true,
    style: { width: "100%" },
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {manual ? (
          <SafeInput
            id={id}
            aria-label={label}
            value={text}
            onChange={(event) => onChange?.(event.target.value)}
            placeholder={placeholder ?? TEMPORAL_FORMATS[kind]}
            size={size}
            autoFocus={autoFocus}
          />
        ) : kind === "time" ? (
          <TimePicker {...pickerProps} showHour showMinute showSecond />
        ) : (
          <DatePicker
            {...pickerProps}
            picker={kind === "year" ? "year" : "date"}
            showTime={kind === "datetime" ? { format: "HH:mm:ss" } : false}
          />
        )}
      </div>
      <Button type="link" size="small" onClick={() => setManual(!manual)}>
        {manual ? "使用选择器" : "手动输入"}
      </Button>
    </div>
  );
}
