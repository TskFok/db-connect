const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseReleaseArgs(args) {
  let dryRun = false;
  const rest = [];

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else {
      rest.push(arg);
    }
  }

  if (rest.length > 1) {
    throw new Error(
      "Usage: npm run release -- [--dry-run] [patch|minor|major|X.Y.Z|current]"
    );
  }

  return { dryRun, bump: rest[0] ?? "patch" };
}

export function formatReleaseTag(version) {
  return `v${version}`;
}

export function bumpVersion(currentVersion, bump) {
  const current = parseSemver(currentVersion, "current version");

  if (bump === "patch") {
    return formatSemver(current.major, current.minor, current.patch + 1);
  }

  if (bump === "minor") {
    return formatSemver(current.major, current.minor + 1, 0);
  }

  if (bump === "major") {
    return formatSemver(current.major + 1, 0, 0);
  }

  if (SEMVER_RE.test(bump)) {
    const next = parseSemver(bump, "explicit version");
    if (compareSemver(next, current) <= 0) {
      throw new Error(
        `Release version ${bump} must be greater than current version ${currentVersion}.`
      );
    }
    return bump;
  }

  throw new Error("Invalid release bump. Use patch, minor, major, or X.Y.Z.");
}

export function updateAppVersionFallback(source, nextVersion) {
  const fallbackRe = /: "(\d+\.\d+\.\d+)";\n\}/;
  if (!fallbackRe.test(source)) {
    throw new Error("Could not find app version fallback in src/appVersion.ts.");
  }
  return source.replace(fallbackRe, `: "${nextVersion}";\n}`);
}

function parseSemver(version, label) {
  const match = SEMVER_RE.exec(version);
  if (!match) {
    throw new Error(`Invalid ${label}: ${version}. Expected X.Y.Z.`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function formatSemver(major, minor, patch) {
  return `${major}.${minor}.${patch}`;
}
