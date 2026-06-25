import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateInsertStatements } from "../utils/sqlUtils";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(),
}));

import { writeText } from "@tauri-apps/plugin-clipboard-manager";

const mockedWriteText = vi.mocked(writeText);

describe("copyAsInsert 剪贴板集成", () => {
  beforeEach(() => {
    mockedWriteText.mockReset();
  });

  it("生成 INSERT 语句后成功写入剪贴板", async () => {
    mockedWriteText.mockResolvedValue(undefined);

    const sql = generateInsertStatements(
      "users",
      ["id", "name", "email"],
      [{ id: 1, name: "Alice", email: "alice@test.com" }]
    );

    await writeText(sql);

    expect(mockedWriteText).toHaveBeenCalledTimes(1);
    expect(mockedWriteText).toHaveBeenCalledWith(
      "INSERT INTO `users` (`id`, `name`, `email`) VALUES (1, 'Alice', 'alice@test.com');"
    );
  });

  it("多行 INSERT 语句正确写入剪贴板", async () => {
    mockedWriteText.mockResolvedValue(undefined);

    const sql = generateInsertStatements(
      "users",
      ["id", "name"],
      [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ]
    );

    await writeText(sql);

    expect(mockedWriteText).toHaveBeenCalledWith(
      "INSERT INTO `users` (`id`, `name`) VALUES (1, 'Alice');\n" +
        "INSERT INTO `users` (`id`, `name`) VALUES (2, 'Bob');"
    );
  });

  it("排除主键后的 INSERT 语句正确写入剪贴板", async () => {
    mockedWriteText.mockResolvedValue(undefined);

    const sql = generateInsertStatements(
      "users",
      ["id", "name", "email"],
      [{ id: 1, name: "Alice", email: "alice@test.com" }],
      ["id"]
    );

    await writeText(sql);

    expect(mockedWriteText).toHaveBeenCalledWith(
      "INSERT INTO `users` (`name`, `email`) VALUES ('Alice', 'alice@test.com');"
    );
  });

  it("writeText 抛出异常时可被捕获", async () => {
    mockedWriteText.mockRejectedValue(new Error("Clipboard access denied"));

    const sql = generateInsertStatements(
      "users",
      ["id", "name"],
      [{ id: 1, name: "Alice" }]
    );

    await expect(writeText(sql)).rejects.toThrow("Clipboard access denied");
    expect(mockedWriteText).toHaveBeenCalledTimes(1);
  });

  it("空 SQL 不应写入剪贴板", () => {
    const sql = generateInsertStatements("users", ["id", "name"], []);

    expect(sql).toBe("");
    expect(mockedWriteText).not.toHaveBeenCalled();
  });

  it("排除所有列后 SQL 为空，不应写入剪贴板", () => {
    const sql = generateInsertStatements("users", ["id"], [{ id: 1 }], ["id"]);

    expect(sql).toBe("");
    expect(mockedWriteText).not.toHaveBeenCalled();
  });

  it("含特殊字符的数据正确写入剪贴板", async () => {
    mockedWriteText.mockResolvedValue(undefined);

    const sql = generateInsertStatements(
      "users",
      ["id", "name", "bio"],
      [{ id: 1, name: "O'Brien", bio: "line1\\line2" }]
    );

    await writeText(sql);

    expect(mockedWriteText).toHaveBeenCalledWith(
      "INSERT INTO `users` (`id`, `name`, `bio`) VALUES (1, 'O''Brien', 'line1\\\\line2');"
    );
  });

  it("含 NULL 值的数据正确写入剪贴板", async () => {
    mockedWriteText.mockResolvedValue(undefined);

    const sql = generateInsertStatements(
      "users",
      ["id", "name", "deleted_at"],
      [{ id: 1, name: "Alice", deleted_at: null }]
    );

    await writeText(sql);

    expect(mockedWriteText).toHaveBeenCalledWith(
      "INSERT INTO `users` (`id`, `name`, `deleted_at`) VALUES (1, 'Alice', NULL);"
    );
  });

  it("排除复合主键后的 INSERT 语句正确写入剪贴板", async () => {
    mockedWriteText.mockResolvedValue(undefined);

    const sql = generateInsertStatements(
      "order_items",
      ["order_id", "product_id", "quantity", "price"],
      [{ order_id: 1, product_id: 100, quantity: 2, price: 9.99 }],
      ["order_id", "product_id"]
    );

    await writeText(sql);

    expect(mockedWriteText).toHaveBeenCalledWith(
      "INSERT INTO `order_items` (`quantity`, `price`) VALUES (2, 9.99);"
    );
  });

  it("writeText 仅被调用一次（不重复写入）", async () => {
    mockedWriteText.mockResolvedValue(undefined);

    const sql = generateInsertStatements(
      "users",
      ["id", "name"],
      [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
        { id: 3, name: "Charlie" },
      ]
    );

    await writeText(sql);

    expect(mockedWriteText).toHaveBeenCalledTimes(1);
  });
});
