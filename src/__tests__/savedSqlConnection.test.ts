import { describe, it, expect } from "vitest";
import type { ConnectionConfig } from "../types";
import {
  savedSqlConnectionKey,
  savedSqlConnectionLabel,
  filterSavedSqlByConnectionKey,
} from "../utils/savedSqlConnection";

function baseConfig(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    name: "本地",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    ...overrides,
  };
}

describe("savedSqlConnection", () => {
  it("有 id 时使用 profile: 前缀", () => {
    const k = savedSqlConnectionKey(baseConfig({ id: "conn-abc" }));
    expect(k).toBe("profile:conn-abc");
  });

  it("无 id 时使用 session 指纹", () => {
    const k = savedSqlConnectionKey(baseConfig());
    expect(k).toMatch(/^session:mysql\|127\.0\.0\.1\|3306\|root\|/);
  });

  it("主机或端口不同则指纹不同", () => {
    const a = savedSqlConnectionKey(baseConfig({ host: "a" }));
    const b = savedSqlConnectionKey(baseConfig({ host: "b" }));
    expect(a).not.toBe(b);
  });

  it("不同数据库类型应生成不同会话指纹", () => {
    const mysql = savedSqlConnectionKey(baseConfig({ database_type: "mysql" }));
    const postgres = savedSqlConnectionKey(
      baseConfig({ database_type: "postgres" })
    );
    const sqlserver = savedSqlConnectionKey(
      baseConfig({ database_type: "sqlserver", port: 1433, username: "sa" })
    );
    expect(mysql).not.toBe(postgres);
    expect(sqlserver).toMatch(/^session:sqlserver\|127\.0\.0\.1\|1433\|sa\|/);
    expect(sqlserver).not.toBe(mysql);
  });

  it("savedSqlConnectionLabel 优先使用连接名称", () => {
    expect(savedSqlConnectionLabel(baseConfig({ name: "生产库" }))).toBe("生产库");
  });

  it("无可用名称时使用 host:port", () => {
    expect(savedSqlConnectionLabel(baseConfig({ name: "  " }))).toBe("127.0.0.1:3306");
  });
});

describe("filterSavedSqlByConnectionKey", () => {
  it("connectionKey 为空时返回空列表", () => {
    expect(
      filterSavedSqlByConnectionKey(
        [{ connectionKey: "profile:a" }, { connectionKey: "profile:b" }],
        ""
      )
    ).toEqual([]);
  });

  it("仅保留键一致的条目", () => {
    const key = "profile:x";
    const filtered = filterSavedSqlByConnectionKey(
      [
        { id: "1", connectionKey: key, name: "a" },
        { id: "2", connectionKey: "profile:y", name: "b" },
        { id: "3", connectionKey: undefined, name: "c" },
      ],
      key
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("1");
  });
});
