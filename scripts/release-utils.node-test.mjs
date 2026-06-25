import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bumpVersion,
  formatReleaseTag,
  parseReleaseArgs,
  updateAppVersionFallback,
} from "./release-utils.mjs";

test("parseReleaseArgs defaults to patch", () => {
  assert.deepEqual(parseReleaseArgs([]), { dryRun: false, bump: "patch" });
});

test("parseReleaseArgs supports dry-run before bump", () => {
  assert.deepEqual(parseReleaseArgs(["--dry-run", "minor"]), {
    dryRun: true,
    bump: "minor",
  });
});

test("parseReleaseArgs supports current", () => {
  assert.deepEqual(parseReleaseArgs(["current"]), {
    dryRun: false,
    bump: "current",
  });
});

test("formatReleaseTag prefixes v", () => {
  assert.equal(formatReleaseTag("1.2.3"), "v1.2.3");
});

test("bumpVersion increments patch by default", () => {
  assert.equal(bumpVersion("0.1.0", "patch"), "0.1.1");
});

test("bumpVersion increments minor and resets patch", () => {
  assert.equal(bumpVersion("0.1.9", "minor"), "0.2.0");
});

test("bumpVersion increments major and resets minor and patch", () => {
  assert.equal(bumpVersion("0.9.9", "major"), "1.0.0");
});

test("bumpVersion accepts a greater explicit version", () => {
  assert.equal(bumpVersion("0.9.9", "1.2.3"), "1.2.3");
});

test("bumpVersion rejects explicit versions that do not increase", () => {
  assert.throws(
    () => bumpVersion("1.2.3", "1.2.3"),
    /must be greater than current version/
  );
});

test("bumpVersion rejects invalid bump arguments", () => {
  assert.throws(() => bumpVersion("1.2.3", "latest"), /Invalid release bump/);
});

test("updateAppVersionFallback replaces the fallback string", () => {
  const source = `declare const __APP_VERSION__: string | undefined;

export function getAppVersion(): string {
  return typeof __APP_VERSION__ === "string" && __APP_VERSION__.length > 0
    ? __APP_VERSION__
    : "0.1.0";
}
`;

  assert.equal(
    updateAppVersionFallback(source, "0.2.0"),
    `declare const __APP_VERSION__: string | undefined;

export function getAppVersion(): string {
  return typeof __APP_VERSION__ === "string" && __APP_VERSION__.length > 0
    ? __APP_VERSION__
    : "0.2.0";
}
`
  );
});
