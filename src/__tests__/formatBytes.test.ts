import { describe, it, expect } from "vitest";
import { formatBytes } from "../utils/formatBytes";

describe("formatBytes", () => {
  it("null/undefined → 显示 -", () => {
    expect(formatBytes(null)).toBe("-");
    expect(formatBytes(undefined)).toBe("-");
  });

  it("0 字节 → 显示 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("常用字节数格式化", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(16384)).toBe("16.0 KB");
    expect(formatBytes(1048576)).toBe("1.0 MB");
  });
});
