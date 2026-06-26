#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  buildReleaseNotes,
  findPreviousReleaseTag,
  formatCommitRange,
  parseGitLog,
} from "./release-notes-utils.mjs";

const currentTag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

if (!currentTag) {
  console.error("Usage: node scripts/release-notes.mjs vX.Y.Z");
  process.exit(1);
}

const tags = git(["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname"])
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
const previousTag = findPreviousReleaseTag(tags, currentTag);
const range = formatCommitRange(currentTag, previousTag);
const log = git(["log", "--first-parent", "--pretty=format:%H%x00%s%x00%b%x1e", range]);

process.stdout.write(buildReleaseNotes(parseGitLog(log)));

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
