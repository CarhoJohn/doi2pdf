import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Run a Git command and return its trimmed UTF-8 output.
 *
 * @param {string[]} args Git command arguments.
 * @returns {string} Command output.
 */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/**
 * Parse a stable vMAJOR.MINOR.PATCH tag into numeric components.
 *
 * @param {string} tag Version tag to parse.
 * @returns {[number, number, number]} Numeric version components.
 */
function parseVersion(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!match) throw new Error(`Expected a stable version tag, got: ${tag}`);
  return match.slice(1).map(Number);
}

const currentTag =
  process.env.GITHUB_REF_NAME ||
  git(["describe", "--tags", "--exact-match", "HEAD"]);
const currentVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
if (currentTag !== `v${currentVersion}`) {
  throw new Error(
    `Tag ${currentTag} does not match package.json version ${currentVersion}`,
  );
}

const stableTags = git(["tag", "--list", "v*", "--sort=-version:refname"])
  .split(/\r?\n/)
  .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
const currentIndex = stableTags.indexOf(currentTag);
if (currentIndex < 0 || currentIndex === stableTags.length - 1) {
  throw new Error(`Could not find a previous stable tag before ${currentTag}`);
}

const previousTag = stableTags[currentIndex + 1];
const [previousMajor, previousMinor, previousPatch] = parseVersion(previousTag);
const [major, minor, patch] = parseVersion(currentTag);
const advanced =
  major > previousMajor ||
  (major === previousMajor && minor > previousMinor) ||
  (major === previousMajor && minor === previousMinor && patch > previousPatch);
if (!advanced)
  throw new Error(`${currentTag} does not advance beyond ${previousTag}`);

const subjects = git(["log", "--format=%s", `${previousTag}..${currentTag}`])
  .split(/\r?\n/)
  .filter(Boolean);
const featureCommit = subjects.some((subject) =>
  /^feat(?:\([^)]*\))?!?:\s+\S/.test(subject),
);
const changeCommit = subjects.some((subject) =>
  /^(?:feat|fix|perf|revert)(?:\([^)]*\))?!?:\s+\S/.test(subject),
);

if (major > previousMajor || minor > previousMinor) {
  if (!featureCommit) {
    throw new Error(
      `${currentTag} increases the major/minor version but has no feat commit since ${previousTag}. ` +
        "Commit the feature separately before creating the release commit and tag.",
    );
  }
} else if (patch > previousPatch && !changeCommit) {
  throw new Error(
    `${currentTag} increases the patch version but has no feat/fix/perf/revert commit since ${previousTag}. ` +
      "Commit the change separately before creating the release commit and tag.",
  );
}

console.log(`Release history check passed: ${previousTag}..${currentTag}`);
