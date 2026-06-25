import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, fireEvent } from "@testing-library/react";
import { SafeInput, SafeInputPassword, SafeTextArea } from "../components/common/SafeInput";
import { sanitizeQuotes } from "../utils/safeInputUtils";

describe("sanitizeQuotes", () => {
  it("空字符串不变", () => {
    expect(sanitizeQuotes("")).toBe("");
  });

  it("无弯引号的字符串不变", () => {
    expect(sanitizeQuotes('hello "world"')).toBe('hello "world"');
    expect(sanitizeQuotes("it's fine")).toBe("it's fine");
  });

  it("左双弯引号 → 直双引号", () => {
    expect(sanitizeQuotes("\u201Chello")).toBe('"hello');
  });

  it("右双弯引号 → 直双引号", () => {
    expect(sanitizeQuotes("hello\u201D")).toBe('hello"');
  });

  it("左右双弯引号同时替换", () => {
    expect(sanitizeQuotes("\u201Chello\u201D")).toBe('"hello"');
  });

  it("左单弯引号 → 直单引号", () => {
    expect(sanitizeQuotes("\u2018hello")).toBe("'hello");
  });

  it("右单弯引号 → 直单引号", () => {
    expect(sanitizeQuotes("hello\u2019")).toBe("hello'");
  });

  it("混合弯引号全部替换", () => {
    expect(sanitizeQuotes("\u201Cname\u201D = \u2018value\u2019")).toBe(
      '"name" = \'value\''
    );
  });

  it("普通直引号不受影响", () => {
    const input = "SELECT * FROM `users` WHERE name = 'test'";
    expect(sanitizeQuotes(input)).toBe(input);
  });
});

describe("SafeInput", () => {
  it("渲染后 input 具有 autoCapitalize / autoCorrect / spellCheck 属性", () => {
    render(React.createElement(SafeInput, { placeholder: "test" }));
    const input = document.querySelector("input")!;
    expect(input).toBeInTheDocument();
    expect(input.getAttribute("autocapitalize")).toBe("off");
    expect(input.getAttribute("autocorrect")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
  });

  it("onChange 中弯引号被替换为直引号", () => {
    const onChange = vi.fn();
    render(React.createElement(SafeInput, { onChange }));
    const input = document.querySelector("input")!;
    fireEvent.change(input, { target: { value: "\u201Chello\u201D" } });
    expect(onChange).toHaveBeenCalled();
    const event = onChange.mock.calls[0][0];
    expect(event.target.value).toBe('"hello"');
  });

  it("无弯引号时 onChange 正常透传", () => {
    const onChange = vi.fn();
    render(React.createElement(SafeInput, { onChange }));
    const input = document.querySelector("input")!;
    fireEvent.change(input, { target: { value: "normal text" } });
    expect(onChange).toHaveBeenCalled();
    const event = onChange.mock.calls[0][0];
    expect(event.target.value).toBe("normal text");
  });
});

describe("SafeInputPassword", () => {
  it("渲染后 input 具有 autoCapitalize / autoCorrect 属性", () => {
    render(React.createElement(SafeInputPassword, { placeholder: "pwd" }));
    const input = document.querySelector("input")!;
    expect(input).toBeInTheDocument();
    expect(input.getAttribute("autocapitalize")).toBe("off");
    expect(input.getAttribute("autocorrect")).toBe("off");
  });
});

describe("SafeTextArea", () => {
  it("渲染后 textarea 具有 autoCapitalize / autoCorrect / spellCheck 属性", () => {
    render(React.createElement(SafeTextArea, { placeholder: "text" }));
    const textarea = document.querySelector("textarea")!;
    expect(textarea).toBeInTheDocument();
    expect(textarea.getAttribute("autocapitalize")).toBe("off");
    expect(textarea.getAttribute("autocorrect")).toBe("off");
    expect(textarea.getAttribute("spellcheck")).toBe("false");
  });

  it("onChange 中弯引号被替换", () => {
    const onChange = vi.fn();
    render(React.createElement(SafeTextArea, { onChange }));
    const textarea = document.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "\u2018test\u2019" } });
    expect(onChange).toHaveBeenCalled();
    const event = onChange.mock.calls[0][0];
    expect(event.target.value).toBe("'test'");
  });
});
