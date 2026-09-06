#!/usr/bin/env node
// One-command release flow for this fork:
//
//   npm run release:patch | release:minor | release:major
//
// Bumps package.json (and the lockfile), commits the bump as `chore: release v<version>`,
// pushes that commit, and pushes the annotated tag `v<version>`. The tag push triggers
// .github/workflows/release.yml, which builds the VSIX, attaches it to a GitHub Release and
// publishes the extension to the VS Marketplace (`vsce publish` with the VSCE_PAT secret).
//
// Safety mirrors scripts/tag-release.mjs: refuses to run off `main` or with a dirty tree, and
// verifies the local branch is in sync with origin before tagging — the Marketplace will not
// accept the same version twice, so a wrong tag is expensive.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const npm = (args) => {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return execFileSync(process.execPath, [npmCli, ...args], { cwd: repoRoot, encoding: "utf8" }).trim();
  }
  return execFileSync("npm", args, { cwd: repoRoot, encoding: "utf8" }).trim();
};
const packageVersion = () => JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const level = process.argv[2] ?? "patch";
if (!["major", "minor", "patch"].includes(level)) {
  fail(`Unknown bump level '${level}'. Use major, minor or patch.`);
}

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") {
  fail(`Not on 'main' (on '${branch}'). Releases are tagged from main only.`);
}

if (git("status", "--porcelain") !== "") {
  fail("Working tree is not clean. Commit or stash your changes before releasing.");
}

git("fetch", "origin", "main", "--tags");
const local = git("rev-parse", "main");
const remote = git("rev-parse", "origin/main");
if (local !== remote) {
  fail("Local 'main' is not in sync with 'origin/main'. Pull/push so they match, then retry.");
}

const oldVersion = packageVersion();
console.log(`Bumping ${oldVersion} → ${level} …`);
npm(["version", level, "--no-git-tag-version"]);
const version = packageVersion();
if (version === oldVersion) {
  fail("Version did not change after the bump — nothing to release.");
}

const tag = `v${version}`;
const existing = git("tag", "--list", tag);
if (existing !== "") {
  fail(`Tag ${tag} already exists locally. Version ${version} was likely already released.`);
}

console.log(`Committing and pushing 'chore: release ${tag}'…`);
git("add", "package.json", "package-lock.json");
git("commit", "-m", `chore: release ${tag}`);
git("push", "origin", branch);

console.log(`Tagging ${tag} on ${git("rev-parse", "--short", "HEAD")} and pushing to origin…`);
git("tag", "-a", tag, "-m", tag);
git("push", "origin", tag);

console.log(`\n✓ Pushed ${tag}. The Release workflow will build the VSIX, create the GitHub Release,`);
console.log(`  and publish to the VS Marketplace. Watch it at:`);
console.log(`  https://github.com/Andrea-Bruno/vs-solution-explorer/actions\n`);
