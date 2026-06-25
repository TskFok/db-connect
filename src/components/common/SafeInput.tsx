import { Input } from "antd";
import type { InputProps, InputRef } from "antd/es/input";
import type { PasswordProps } from "antd/es/input/Password";
import type { TextAreaProps } from "antd/es/input/TextArea";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { forwardRef } from "react";
import { sanitizeQuotes } from "../../utils/safeInputUtils";

const SAFE_PROPS = {
  autoCapitalize: "off" as const,
  autoCorrect: "off" as const,
  spellCheck: false,
};

/**
 * 封装 antd Input，自动禁用首字母大写、自动纠正、拼写检查，
 * 并在 onChange 中将智能引号替换为直引号。
 */
export const SafeInput = forwardRef<InputRef, InputProps>((props, ref) => {
  const handleChange: InputProps["onChange"] = (e) => {
    const raw = e.target.value;
    const sanitized = sanitizeQuotes(raw);
    if (sanitized !== raw) {
      const cursorPos = e.target.selectionStart;
      e.target.value = sanitized;
      if (cursorPos !== null) {
        e.target.setSelectionRange(cursorPos, cursorPos);
      }
    }
    props.onChange?.(e);
  };

  return <Input {...props} {...SAFE_PROPS} ref={ref} onChange={handleChange} />;
});

SafeInput.displayName = "SafeInput";

/** 封装 antd Input.Password */
export const SafeInputPassword = forwardRef<InputRef, PasswordProps>(
  (props, ref) => {
    const handleChange: PasswordProps["onChange"] = (e) => {
      const raw = e.target.value;
      const sanitized = sanitizeQuotes(raw);
      if (sanitized !== raw) {
        e.target.value = sanitized;
      }
      props.onChange?.(e);
    };

    return (
      <Input.Password
        {...props}
        {...SAFE_PROPS}
        ref={ref}
        onChange={handleChange}
      />
    );
  },
);

SafeInputPassword.displayName = "SafeInputPassword";

/** 封装 antd Input.TextArea */
export const SafeTextArea = forwardRef<TextAreaRef, TextAreaProps>(
  (props, ref) => {
    const handleChange: TextAreaProps["onChange"] = (e) => {
      const raw = e.target.value;
      const sanitized = sanitizeQuotes(raw);
      if (sanitized !== raw) {
        e.target.value = sanitized;
      }
      props.onChange?.(e);
    };

    return (
      <Input.TextArea
        {...props}
        {...SAFE_PROPS}
        ref={ref}
        onChange={handleChange}
      />
    );
  },
);

SafeTextArea.displayName = "SafeTextArea";
