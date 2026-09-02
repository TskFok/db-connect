import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** GHSA-c83g-rgw3-j3cx / GHSA-73wf-gq98-2v4g：browserslist <=4.28.6 */
const BROWSERSLIST_VULN_MAX = [4, 28, 6] as const;

function parseSemverPrefix(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    throw new Error(`无法解析 semver: ${version}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isLessOrEqual(
  version: [number, number, number],
  max: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== max[i]) {
      return version[i] < max[i];
    }
  }
  return true;
}

describe("npm audit 依赖覆盖", () => {
  const root = process.cwd();
  const packageJson = JSON.parse(
    readFileSync(join(root, "package.json"), "utf-8"),
  ) as {
    overrides?: Record<string, string>;
  };
  const lockfile = JSON.parse(
    readFileSync(join(root, "package-lock.json"), "utf-8"),
  ) as {
    packages?: Record<string, { name?: string; version?: string }>;
  };

  it("overrides 将 browserslist 钉到不受影响的版本", () => {
    const override = packageJson.overrides?.browserslist;
    expect(override, "package.json overrides.browserslist 缺失").toBeTruthy();
    const version = parseSemverPrefix(String(override).replace(/^[^\d]*/, ""));
    expect(isLessOrEqual(version, BROWSERSLIST_VULN_MAX)).toBe(false);
  });

  it("lockfile 中不存在受影响的 browserslist", () => {
    const packages = lockfile.packages ?? {};
    const browserslistEntries = Object.entries(packages).filter(([path, pkg]) => {
      const name = pkg.name ?? path.split("node_modules/").pop();
      return name === "browserslist" && Boolean(pkg.version);
    });

    expect(browserslistEntries.length).toBeGreaterThan(0);
    for (const [path, pkg] of browserslistEntries) {
      const version = parseSemverPrefix(pkg.version as string);
      expect(
        isLessOrEqual(version, BROWSERSLIST_VULN_MAX),
        `${path} 仍为易受攻击的 browserslist@${pkg.version}`,
      ).toBe(false);
    }
  });
});
