# Fork guide — what was done, how to proceed

Operational companion to [architecture.md](architecture.md). This page answers: *what does the fork
contain, how do I keep it in sync with upstream, how do I ship a new version, and what is still
open.*

---

## 1. Identity

| | |
| --- | --- |
| GitHub repo | https://github.com/Andrea-Bruno/vs-solution-explorer (fork of `Jomblebee/csharp-solution-explorer`) |
| Marketplace | `andreabruno.csharp-solution-explorer-community` — display name **"VS Solution Explorer"** |
| Remotes (local) | `origin` = this fork · `upstream` = Jomblebee/csharp-solution-explorer |
| Default branch | `main` (release scripts require `main`); `my-version` was the integration branch of the initial fork work (kept for reference) |

Marketplace display-name and extension-name are **globally unique**: `C# Solution Explorer` (the
vendor's display name) and the plain `csharp-solution-explorer` name were already taken, hence the
`-community` suffix. These are fixed for the lifetime of the extension; changing them later means a
new Marketplace item.

## 2. What the fork adds (shipped)

1. **Whole-solution file search** in the Solution Explorer (search bar above the tree, filters by
   file name like Visual Studio, matches auto-revealed).
2. **Run toolbar** above the tree: ▶ Start (debugs the startup project — no `launch.json` needed)
   + build-configuration dropdown (Debug/Release + declared `<Configurations>`), persisted per
   workspace and applied to Build/Run/Test/Debug.
3. **Startup project limited to runnable projects** — class libraries are refused.
4. **Fix**: Options panel referenced a non-existent `media/options/nav.js`; it now loads
   `shared/nav.js` (upstream bug, still present on the vendor's `main` — worth reporting upstream).
5. **Fix**: `generate-third-party-notices.mjs` now runs on Windows (`npm_execpath`), so
   `npm run vsix` works locally.
6. **Release automation** — one command from `main` ships a new version (see §4).

Design details for 1–3 live in [architecture.md](architecture.md).

## 3. Development & verification

```bash
npm ci
# VS Code: press F5 → Extension Development Host opens samples/TaskFlow
npm run check-types && npm run lint && npm test
npm run vsix            # now works on Windows (fork fix)
```

Notes:

- Unit tests may not import `vscode` (see CONTRIBUTING). `test/` mirrors `src/`.
- **4 tests fail on Windows** (`debugConfig`, `launchSettingsReader`, `projectAssetsReader`):
  pre-existing upstream POSIX-path assertions; the upstream CI runs Linux. Not caused by the fork.
- Anything user-visible (tree, toolbar rows, context menus) needs a manual pass with F5.

## 4. Shipping a new version

Prerequisite (one time): the repo secret `VSCE_PAT` — a PAT with **Marketplace → Manage** scope
from the Azure account that owns the publisher `andreabruno`:

```sh
gh secret set VSCE_PAT -R Andrea-Bruno/vs-solution-explorer
```

Then, on a clean `main` in sync with `origin/main`:

```sh
npm run release:patch    # or release:minor / release:major
```

What happens:

1. `scripts/bump-release.mjs` verifies branch = `main`, tree clean, sync with origin; bumps
   `package.json` + lockfile (`npm version <level> --no-git-tag-version`); commits
   `chore: release vX.Y.Z`; pushes the commit and the annotated tag `vX.Y.Z`.
2. The push of tag `vX.Y.Z` triggers `.github/workflows/release.yml` (GitHub Actions):
   - verifies the tag equals `package.json` `version`,
   - `npm ci` → `npm run package` → `npm run vsix`,
   - creates a **GitHub Release** with the `.vsix` attached,
   - publishes to the **VS Marketplace** with `vsce` using `VSCE_PAT`.

Manual alternative (same result): bump the version yourself, push the `chore: release` commit, then
`npm run release:tag` (creates/pushes only the tag).

Watch the run: https://github.com/Andrea-Bruno/vs-solution-explorer/actions.
If Actions are disabled on the fork, enable them in Settings → Actions first.

> The Marketplace rejects a version it has already seen — that is why both scripts refuse to tag
> from a dirty/sync-stale `main`, and why the workflow double-checks tag == manifest.

## 5. Keeping in sync with upstream

The vendor releases regularly. To absorb a release:

```sh
git checkout my-version      # integration branch, mirrors upstream + our delta
git fetch upstream
git merge upstream/main      # or: git fetch upstream && git merge upstream/main --no-edit
# resolve conflicts, then verify
npm run check-types && npm run lint && npm test
```

Conflict hotspots to expect (they contain fork-specific content):

- `package.json` — identity fields, description, scripts (`release:*`), `contributes.views` rows.
- `.github/workflows/release.yml` — ours publishes to the Marketplace instead of Open VSX.
- `scripts/tag-release.mjs` / `generate-third-party-notices.mjs` — fork wording/fixes.
- `src/extension.ts`, `solutionTreeDataProvider.ts`, `launchProfileStatusBar.ts`-adjacent wiring.

After the merge, open a PR `my-version → main`, and once merged ship via §4. Keep `main` as the
branch releases are tagged from.

## 6. Current status & open items

Done (shipped in code, on `main`): items in §2.

Open / next steps:

- [ ] **Marketplace validation** — the first manual upload ("VS Solution Explorer" v0.16.0) was in
      *Verifying* status; confirm the item is live and note its URL in this file.
- [ ] **Set the `VSCE_PAT` secret** (§4) before the first automated release.
- [ ] **Try ▶ in anger** with and without Microsoft's C# Dev Kit installed. With C# Dev Kit present
      F5 belongs to Microsoft's stack by design; the toolbar ▶ still starts the fork's netcoredbg
      debugger — verify no double-debugger side effects.
- [ ] Optional: publish to Open VSX (needs an `OVSX_PAT` + a workflow step) if the fork should be
      available on VSCodium.
- [ ] Consider reporting the `options/nav.js` bug upstream (fix is one line).

Suggested manual test script (F5 → `samples/TaskFlow` or the AIOffice solution):

1. Search bar: type `appsettings` → only matching files with parent folders appear, auto-expanded;
   ✕ / `Esc` / title-bar ✕ restores the tree.
2. Run toolbar: pick a runnable project as startup ("Set as Startup Project"); select **Release**
   in the dropdown; press ▶ → a build (Release) then a debug session starts — **no launch.json**.
3. Try "Set as Startup Project" on a class library → a warning explains libraries cannot start.
4. Build/Run/Test on a project → the terminal command line contains the chosen `-c`/`--configuration`.
