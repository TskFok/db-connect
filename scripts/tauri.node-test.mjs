import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveTauriEnvironment } from "./tauri.mjs";

function withSDKs(run) {
  const directory = mkdtempSync(join(tmpdir(), "tauri-sdk-test-"));
  for (const name of [
    "MacOSX.sdk",
    "MacOSX27.0.sdk",
    "MacOSX26.5.sdk",
    "MacOSX15.4.sdk",
  ]) {
    mkdirSync(join(directory, name));
  }
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function toolchain(directory, { compatibleSDK, error } = {}) {
  return (command, args, options) => {
    if (command === "xcrun") {
      assert.deepEqual(args, ["--sdk", "macosx", "--show-sdk-path"]);
      return { status: 0, stdout: `${join(directory, "MacOSX27.0.sdk")}\n` };
    }
    assert.equal(command, "cc");
    assert.ok(options.input.includes("int main"));
    const sdk = options.env.SDKROOT;
    return sdk === compatibleSDK
      ? { status: 0, stderr: "" }
      : {
          status: 1,
          stderr:
            error ??
            "libSystem.tbd: error: unknown architecture arm64e.x1-macos",
        };
  };
}

test("默认 SDK 架构不受支持时，为构建选择能链接的已安装 SDK", () => {
  withSDKs((directory) => {
    const compatibleSDK = join(directory, "MacOSX.sdk");
    const env = resolveTauriEnvironment({
      platform: "darwin",
      args: ["build"],
      env: { PATH: "/usr/bin", KEEP: "unchanged" },
      run: toolchain(directory, { compatibleSDK }),
    });
    assert.equal(env.SDKROOT, compatibleSDK);
    assert.equal(env.KEEP, "unchanged");
  });
});

test("默认 SDK 别名也不兼容时继续检测版本目录，开发命令同样可用", () => {
  withSDKs((directory) => {
    const compatibleSDK = join(directory, "MacOSX26.5.sdk");
    const env = resolveTauriEnvironment({
      platform: "darwin",
      args: ["dev"],
      env: {},
      run: toolchain(directory, { compatibleSDK }),
    });
    assert.equal(env.SDKROOT, compatibleSDK);
  });
});

test("编译子命令前的全局 verbose 参数不绕过 SDK 检测", () => {
  withSDKs((directory) => {
    const compatibleSDK = join(directory, "MacOSX.sdk");
    for (const args of [
      ["--verbose", "build"],
      ["-vv", "dev"],
    ]) {
      const env = resolveTauriEnvironment({
        platform: "darwin",
        args,
        env: {},
        run: toolchain(directory, { compatibleSDK }),
      });
      assert.equal(env.SDKROOT, compatibleSDK);
    }
  });
});

test("显式 SDKROOT、其他平台和非编译命令不探测或覆盖环境", () => {
  for (const [platform, args, env] of [
    ["darwin", ["build"], { SDKROOT: "/custom/sdk" }],
    ["win32", ["build"], {}],
    ["linux", ["build"], {}],
    ["darwin", ["--version"], {}],
    ["darwin", ["icon", "image.png"], {}],
  ]) {
    assert.equal(
      resolveTauriEnvironment({
        platform,
        args,
        env,
        run: () => assert.fail("不应调用工具链"),
      }),
      env
    );
  }
});

test("默认 SDK 可用时保留原环境", () => {
  withSDKs((directory) => {
    const env = {};
    assert.equal(
      resolveTauriEnvironment({
        platform: "darwin",
        args: ["build"],
        env,
        run: toolchain(directory, {
          compatibleSDK: join(directory, "MacOSX27.0.sdk"),
        }),
      }),
      env
    );
  });
});

test("无可用 SDK 或编译器发生其他错误时不掩盖原始构建错误", () => {
  withSDKs((directory) => {
    for (const error of [undefined, "cc: error: compiler unavailable"]) {
      const env = {};
      assert.equal(
        resolveTauriEnvironment({
          platform: "darwin",
          args: ["build"],
          env,
          run: toolchain(directory, { error }),
        }),
        env
      );
    }
  });
});
