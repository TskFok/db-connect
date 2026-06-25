import { describe, expect, it } from "vitest";
import { formatTruncateTableError } from "../utils/truncateTableErrors";

describe("formatTruncateTableError", () => {
  it("外键相关错误附加提示", () => {
    const s = formatTruncateTableError(
      "Error 1701 (42000): Cannot truncate a table referenced in a foreign key constraint"
    );
    expect(s).toContain("1701");
    expect(s).toContain("外键");
  });

  it("权限错误附加提示", () => {
    const s = formatTruncateTableError(
      "Access denied for user 'x'@'%' to database 'db'"
    );
    expect(s).toContain("Access denied");
    expect(s).toContain("DROP");
  });

  it("未知错误原样返回", () => {
    expect(formatTruncateTableError("random")).toBe("random");
  });
});
