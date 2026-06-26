import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildReleaseNotes,
  findPreviousReleaseTag,
  formatCommitRange,
} from "./release-notes-utils.mjs";

test("buildReleaseNotes groups direct conventional commits and skips release commits", () => {
  const notes = buildReleaseNotes([
    {
      hash: "e06ed30ee242b263772761f19b79a807493d09ca",
      subject: "发布 v1.0.1",
      body: "",
    },
    {
      hash: "86a5bdd2b6ca1c9d977d3bf6a85eb67309b09189",
      subject: "feat: 连接表单操作区固定底部，表单内容独立滚动",
      body: "",
    },
    {
      hash: "9e51a4a48e7fc6431b3a84961a422413bf3a4a97",
      subject: "fix: 同步 appVersion 默认回退版本为 1.0.0",
      body: "",
    },
  ]);

  assert.equal(
    notes,
    `## Features

- 连接表单操作区固定底部，表单内容独立滚动 (\`86a5bdd\`)

## Bug Fixes

- 同步 appVersion 默认回退版本为 1.0.0 (\`9e51a4a\`)

## 安装包

多平台安装包见本 Release 附件。
`
  );
});

test("buildReleaseNotes falls back to merge commit body title", () => {
  const notes = buildReleaseNotes([
    {
      hash: "1234567890abcdef",
      subject: "Merge pull request #12 from TskFok/feature",
      body: "feat: 支持直接提交生成 changelog\n\n详细说明",
    },
  ]);

  assert.match(notes, /## Features/);
  assert.match(notes, /- 支持直接提交生成 changelog \(`1234567`\)/);
});

test("buildReleaseNotes renders no changes when only release commits exist", () => {
  const notes = buildReleaseNotes([
    {
      hash: "e06ed30ee242b263772761f19b79a807493d09ca",
      subject: "发布 v1.0.1",
      body: "",
    },
  ]);

  assert.equal(
    notes,
    `* No changes

## 安装包

多平台安装包见本 Release 附件。
`
  );
});

test("findPreviousReleaseTag returns the semver tag before the current tag", () => {
  assert.equal(findPreviousReleaseTag(["v1.0.2", "v1.0.1", "v1.0.0"], "v1.0.1"), "v1.0.0");
});

test("findPreviousReleaseTag returns null for the first release", () => {
  assert.equal(findPreviousReleaseTag(["v1.0.0"], "v1.0.0"), null);
});

test("formatCommitRange uses previous tag when available", () => {
  assert.equal(formatCommitRange("v1.0.1", "v1.0.0"), "v1.0.0..v1.0.1");
});

test("formatCommitRange uses current tag for first release", () => {
  assert.equal(formatCommitRange("v1.0.0", null), "v1.0.0");
});
