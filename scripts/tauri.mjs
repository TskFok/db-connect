import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveTauriEnvironment({
  platform = process.platform,
  args = process.argv.slice(2),
  env = process.env,
  run = spawnSync,
} = {}) {
  const command = args.find((arg) => !/^(?:-v+|--verbose)$/.test(arg));
  if (
    platform !== "darwin" ||
    env.SDKROOT ||
    !["build", "dev"].includes(command)
  ) {
    return env;
  }

  const sdkResult = run("xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  const defaultSDK = sdkResult.stdout?.trim();
  if (sdkResult.status !== 0 || !defaultSDK) return env;

  const directory = mkdtempSync(join(tmpdir(), "tauri-sdk-probe-"));
  try {
    // 同时检查头文件和链接，避免只根据 SDK 版本猜测工具链兼容性。
    const probe = (sdk) =>
      run("cc", ["-x", "c", "-", "-o", join(directory, "probe")], {
        env: { ...env, SDKROOT: sdk },
        input:
          '#include <stdio.h>\nint main(void) { return puts("sdk") < 0; }\n',
        encoding: "utf8",
        timeout: 10_000,
      });

    const result = probe(defaultSDK);
    if (
      result.status === 0 ||
      !result.stderr?.includes("unknown architecture") ||
      !result.stderr.includes(".tbd")
    ) {
      return env;
    }

    let installedSDKs;
    try {
      installedSDKs = readdirSync(dirname(defaultSDK))
        .filter((name) => /^MacOSX\d+(?:\.\d+)*\.sdk$/.test(name))
        .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
    } catch {
      return env;
    }

    // 优先尝试工具链的默认别名，再检查同一工具链下的其他已安装版本。
    for (const name of ["MacOSX.sdk", ...installedSDKs]) {
      const sdk = join(dirname(defaultSDK), name);
      if (sdk !== defaultSDK && probe(sdk).status === 0) {
        return { ...env, SDKROOT: sdk };
      }
    }
    return env;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const env = resolveTauriEnvironment();
  if (env.SDKROOT && env.SDKROOT !== process.env.SDKROOT) {
    process.env.SDKROOT = env.SDKROOT;
    console.warn(`[tauri] 默认 macOS SDK 与链接器不兼容，使用 ${env.SDKROOT}`);
  }
  await import("@tauri-apps/cli/tauri.js");
}
