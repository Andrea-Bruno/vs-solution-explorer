# Architecture — VS Solution Explorer (community fork)

This document describes the architecture of the fork, what the upstream extension already
provided, and exactly how each fork addition is designed. The goal is that a future contributor can
read this page and know *why* a piece of code looks the way it does, and where to extend it.

Upstream ("the vendor") is [Jomblebee/csharp-solution-explorer](https://github.com/Jomblebee/csharp-solution-explorer).
Everything not marked **(fork)** ships in the vendor's extension too.

---

## 1. Big picture

The extension is a native VS Code `TreeDataProvider` (a "Solution Explorer" in its own activity-bar
container) plus a set of panels/views around it:

- The **tree** (`csharpSolutionExplorer.view`) shows solutions → projects → folders/files, with a
  per-project **Dependencies** subtree. Nodes are created lazily per expanded level by
  `SolutionTreeDataProvider` (`src/solutionExplorer/tree/solutionTreeDataProvider.ts`).
- The container `csharp-solution-explorer-activitybar` hosts, **in vertical order** (top first —
  order is the order in `contributes.views`):
  1. **(fork)** the single control bar `csharpSolutionExplorer.runControlsView` — "Run & Search"
     (▶ Start, build configuration, file filter),
  2. the tree view `csharpSolutionExplorer.view` — "Solution Explorer".
  Users can reorder these by dragging; the contributed order is only the default.
- Panels (editor tabs, not views) cover NuGet, Project Properties, Options and the Test Run
  Dashboard; the debugger/test-explorer/language-server subsystems are activated from
  `src/extension.ts`.

### The control bar (fork UI pattern)

The single fork row is a slim `WebviewViewProvider` with inline HTML (nonce-based CSP, no `media/`
assets), carrying ▶, the configuration dropdown and the file filter. Message contract:

- Extension → view: `webview.postMessage({ type: "state", ... })` — the host is the source of truth
  and pushes full state; the view never assumes anything.
- View → extension: `postMessage({ type: "action", ... })` — e.g. `filter`/`start`/`config`.
- `retainContextWhenHidden: true` keeps the input value across view toggling.

`makeNonce()` comes from `src/shared/webviewHtml.ts`. See `runControls/registerRunControls.ts` for
the complete example.

---

## 2. (fork) Filtering the tree like Visual Studio's search

UI: the **filter box** at the right end of the Run & Search bar. Behaviour mirrors Visual Studio's
Solution Explorer search: typing keeps only files whose **file name** contains the text, with the
folders and projects that lead to them, and every match is auto-revealed/expanded.

### Files

| File | Role |
| --- | --- |
| `src/solutionExplorer/search/fileNameMatch.ts` | Pure matching rules (no `vscode` import → unit-tested). |
| `src/solutionExplorer/runControls/registerRunControls.ts` | The Run & Search bar (▶, config, filter), filter funnel, clear command/context key. |
| changes in `tree/solutionTreeDataProvider.ts` | Filtered snapshot + `setSearchFilter()` + status event. |

### Design decisions

- **Matching.** Case-insensitive substring of the file name, extension included ("Program" finds
  `Program.cs`; "Program.cs" narrows). Only *files* match; folders/solutions/projects are kept
  purely as containers when they lead to a match. `NestedFileTreeItem` parents (e.g. `Page.xaml`
  next to `Page.xaml.cs`) count as files too: kept when their own name matches *or* a companion
  does.
- **Filtered snapshot, not lazy pruning.** While a filter is active, the provider walks the whole
  (unfiltered) tree once and materialises `SolutionFileSearchSession`:
  - `roots` — kept top-level items,
  - `leaves` — the matching file items,
  - `childrenOf: WeakMap` — filtered children per kept container.
  `getChildren()` then returns the cached instances. This gives every kept node a **stable
  instance and a recorded parent**, which is what makes `TreeView.reveal(leaf, { expand: true })`
  work: VS Code walks `getParent()` from the leaf to the root. With lazy per-level pruning that
  chain would not exist and deep matches could never be auto-expanded.
- **Pruning rule.** A container is kept iff it is *searchable* (Solution, Solution Folder, Project,
  Folder, `NestedFileTreeItem`) **and** has a kept descendant. `Dependencies` and everything under
  it is file-free, so it is dropped **without being walked** — that keeps typing cheap on big
  solutions. Search runs only over what the solution explorer already shows (including projects
  outside the workspace folder: project roots are read directly off disk).
- **Re-runs & supersession.** Each `setSearchFilter()`/`refresh()` starts `runSearch(query)` with a
  monotonic `searchRunId`; a run that finishes after a newer one started is discarded. The file
  watcher (`scheduleRefresh`) re-runs the active search when files change. Typing is debounced in
  the webview (120 ms).
- **Status & reset.** `onDidChangeSearchStatus` reports `building/ready/cleared` + match count; the
  extension maps it to `treeView.message` ("Searching files…", "No files match …") and to the
  `csharpSolutionExplorer.searchActive` context key. Clearing happens via the row's ✕, `Esc`, or the
  ✕ button contributed to the tree view's title bar (`package.json` `view/title`, gated on
  `searchActive`).
- **Auto-expansion.** After a `ready` run the extension reveals leaves (cap 200) in up to 5 passes
  with a 40 ms pause; a pass may fail while the view has not yet asked for a level, so leaves are
  retried on the next pass. Failures are ignored — the tree stays correct either way.

### Known limits

- The watcher covers the **workspace folder**; projects referenced from outside it refresh only on
  manual refresh or workspace changes (same as upstream's browsing).
- Each keystroke after the debounce re-walks the solution (folder listings are not cached between
  queries); acceptable today, a per-directory mtime cache is the obvious next optimisation.

---

## 3. (fork) Run & Search bar — Start + build configuration

UI: the **Run & Search** row above the tree — a green ▶, the build-configuration dropdown and the
file filter. It mirrors the parts of Visual Studio's toolbar people use most: *Start*,
*Debug/Release*, and searching the explorer.

### Files

| File | Role |
| --- | --- |
| `src/solutionExplorer/runControls/buildConfigurationState.ts` | Persisted per-workspace configuration (module singleton, see §5). |
| `src/solutionExplorer/runControls/buildConfigurations.ts` | Pure: parse `<Configurations>` from a csproj + merge with defaults (unit-tested). |
| `src/solutionExplorer/runControls/registerRunControls.ts` | The bar (webview), filter funnel, clear command/context key, top-bar "Build Configuration…" quick pick. |
| edits | `extension.ts` (init/register), `commands/buildCommands.ts`, `debug/debugConfigurationProvider.ts`, `debug/externalTerminal/externalTerminalDebug.ts` (threading), `launchProfiles/launchProfileCommands.ts` + `workspaceProjects.ts` (startup gating). |

### ▶ Start — no launch.json, ever

The ▶ button executes `csharpSolutionExplorer.debug.start` — the same command the fork's F5
ownership registers (`src/debug/f5Ownership.ts`). That path builds the startup project, resolves
`launchSettings.json` and asks MSBuild what was produced, all in memory. If the bundled debugger is
disabled the command falls back to VS Code's own start.

**Important UX clarification:** the status-bar ▶ item with the startup project's name (vendor code,
`launchProfileStatusBar.ts`) is a *picker* — it opens the startup-project chooser. The real Start
button is the toolbar's ▶. This was the source of "the play button does nothing".

### Configuration dropdown

- The list always contains `Debug` and `Release`, plus any names the **startup project** declares
  via `<Configurations>Debug;Release;QA</Configurations>` (first occurrence, plain regex — MSBuild
  conditions are not evaluated, matching the existing `parseOutputType` behaviour).
- The selection is persisted in workspace state and defaults to `Debug` (which is also what every
  vendor code path hard-coded before this fork — see §4).
- Threading points (all reads `getBuildConfiguration()`):
  - tree commands `Build`/`Rebuild` → `dotnet build … -c <cfg>`, `Run` → `dotnet run … --configuration
    <cfg>`, `Test` → `dotnet test … --configuration <cfg>` (`commands/buildCommands.ts`),
  - the debug configuration provider → used when a `launch.json` does **not** set `configuration`
    (`partial.configuration ?? getBuildConfiguration()`),
  - the external-terminal debug flow (was a hard-coded `"Debug"`),
  - (internal) the provider's pre-build passes the resolved configuration to `dotnetCli.build`
    and `queryProjectOutput`.
- The Test Explorer's internal runs stay on `Debug` (test infra, out of scope).

### Startup project = runnable only

Visual Studio refuses to start a class library; so does this fork:

- `Set as Startup Project` (context menu) now runs `isStartableProject()` — `isDebuggableProject(
  parseSdkAttribute(text), parseOutputType(text))` from `parsers/csprojReader.ts`. `Exe`/`WinExe`
  and Web/Blazor WebAssembly SDKs pass; `Library`/`Module` fail with a warning. A read failure
  fails open (a project must never be un-settable just because its file is unreadable).
- The startup-project picker (`workspaceProjects.ts` `promptForStartupProject`) lists **only**
  runnable projects now — the old Test/Library sections were removed.

---

## 4. Configuration & debug hard-coding that predates the fork

Before this fork there was **no build-configuration concept**; `"Debug"` was hard-coded in:
`dotnetCli.ts build()`, `debug/projectOutput.ts` (default param), `debugConfigurationProvider.ts`,
`debug/externalTerminal/externalTerminalDebug.ts`, `msbuildProperties.ts`,
`projectPropertiesService.ts` (cache key) and the test-explorer internals. Only a hand-written
`launch.json` `configuration` field could change it. §3's state module replaces the user-facing
defaults; the internal test-infra defaults are untouched by design.

---

## 5. State & event patterns (fork modules follow the upstream singleton pattern)

`launchProfileState.ts` is the template: module-level singleton, `init*(context)` hydrating from
`context.workspaceState`, sync getters, setters that persist + fire a module `EventEmitter`, and a
dispose function pushed into `context.subscriptions`. The fork's `buildConfigurationState.ts`
copies it exactly (own key `csharpSolutionExplorer.buildConfiguration`, own emitter
`onDidChangeBuildConfiguration`, `disposeBuildConfiguration`). Context keys mirrored via
`setContext`:

| Key | Meaning |
| --- | --- |
| `csharpSolutionExplorer.hasStartupProject` | a startup project is set (upstream) |
| `csharpSolutionExplorer.searchActive` | **(fork)** a file search filters the tree |

---

## 6. Packaging, identity and release pipeline (fork)

- **Identity**: publisher `andreabruno`, extension name `csharp-solution-explorer-community`
  (globally unique — `csharp-solution-explorer` and the display name `C# Solution Explorer` were
  already taken on the Marketplace), display name **"VS Solution Explorer"**.
  Marketplace page: `andreabruno.csharp-solution-explorer-community`.
- **Cross-platform packaging fix**: `scripts/generate-third-party-notices.mjs` used
  `execFileSync("npm", …)`, which cannot launch `npm.cmd` on Windows. The fork added `runNpm()`
  that prefers `process.execPath` + `npm_execpath` (works everywhere `npm run` is used) and falls
  back to the plain executable elsewhere.
- **Release flow** — see `docs/fork-guide.md` for the step-by-step. In short:
  `scripts/bump-release.mjs` (`npm run release:patch|minor|major`) bumps the version, commits
  `chore: release vX.Y.Z`, pushes the commit and the `v*` tag; `.github/workflows/release.yml`
  verifies tag == manifest version, runs `npm run package` + `npm run vsix`, creates a GitHub
  Release with the VSIX, and publishes with `vsce` using the repository secret `VSCE_PAT`.

---

## 7. Conventions to keep when extending

1. **Pure logic first** — no test imports `vscode`. Matching/parsing/merge rules live in
   `*Configurations.ts`/`fileNameMatch.ts`-style modules; the vscode shell stays thin.
2. `test/` mirrors `src/` path-for-path; run `npm run check-types && npm run lint && npm test`
   (4 POSIX-path tests fail on Windows only — upstream, pre-existing).
3. Persisted per-workspace values go through the §5 singleton pattern.
4. New webview rows follow the §1 message contract and are contributed at the top of
   `contributes.views["csharp-solution-explorer-activitybar"]` to stay above the tree.
5. Config values are threaded by reading `getBuildConfiguration()` at the call site — there is no
   global re-configuration event bus to subscribe to (the emitter exists for the toolbar UI).
6. Anything user-visible gets a pass in the Extension Development Host (`samples/TaskFlow`) and a
   note in the README/docs.
