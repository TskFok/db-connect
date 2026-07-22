const RELEASE_COMMIT_RE = /^发布：v\d+\.\d+\.\d+$/;
const CONVENTIONAL_COMMIT_RE = /^([a-z]+)(?:\([^)]+\))?!?:\s+(.+)$/i;
const SEMVER_TAG_RE = /^v\d+\.\d+\.\d+$/;

const CATEGORY_DEFS = [
  { title: "Features", types: ["feat"] },
  { title: "Bug Fixes", types: ["fix"] },
  { title: "Refactors", types: ["refactor"] },
  { title: "Documentation", types: ["docs"] },
  { title: "Tests", types: ["test"] },
  { title: "Build System", types: ["build"] },
  { title: "Continuous Integration", types: ["ci"] },
  { title: "Miscellaneous", types: ["chore"] },
];

const TYPE_TO_CATEGORY = new Map(
  CATEGORY_DEFS.flatMap((category) =>
    category.types.map((type) => [type, category.title])
  )
);

export function buildReleaseNotes(commits) {
  const grouped = new Map(CATEGORY_DEFS.map(({ title }) => [title, []]));

  for (const commit of commits) {
    const change = parseChange(commit);
    if (!change) continue;

    const title = TYPE_TO_CATEGORY.get(change.type) ?? "Miscellaneous";
    grouped.get(title).push(`- ${escapeMarkdown(change.text)} (\`${shortHash(commit.hash)}\`)`);
  }

  const sections = [];
  for (const { title } of CATEGORY_DEFS) {
    const entries = grouped.get(title);
    if (entries.length > 0) {
      sections.push(`## ${title}\n\n${entries.join("\n")}`);
    }
  }

  const changes = sections.length > 0 ? sections.join("\n\n") : "* No changes";
  return `${changes}\n\n## 安装包\n\n多平台安装包见本 Release 附件。\n`;
}

export function findPreviousReleaseTag(tags, currentTag) {
  const releaseTags = tags.filter((tag) => SEMVER_TAG_RE.test(tag));
  const currentIndex = releaseTags.indexOf(currentTag);
  if (currentIndex >= 0) {
    return releaseTags[currentIndex + 1] ?? null;
  }

  return releaseTags.find((tag) => tag !== currentTag) ?? null;
}

export function formatCommitRange(currentTag, previousTag) {
  return previousTag ? `${previousTag}..${currentTag}` : currentTag;
}

export function parseGitLog(log) {
  return log
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash = "", subject = "", body = ""] = entry.split("\x00");
      return { hash, subject, body };
    });
}

function parseChange(commit) {
  const subject = commit.subject.trim();
  if (RELEASE_COMMIT_RE.test(subject)) {
    return null;
  }

  return parseConventionalTitle(subject) ?? parseConventionalTitle(firstBodyLine(commit.body));
}

function parseConventionalTitle(title) {
  const match = CONVENTIONAL_COMMIT_RE.exec(title.trim());
  if (!match) {
    return null;
  }

  return {
    type: match[1].toLowerCase(),
    text: match[2].trim(),
  };
}

function firstBodyLine(body) {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function shortHash(hash) {
  return hash.slice(0, 7);
}

function escapeMarkdown(text) {
  return text.replace(/[`*_\\]/g, "\\$&");
}
