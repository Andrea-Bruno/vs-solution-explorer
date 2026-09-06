import * as path from "node:path";
import * as vscode from "vscode";
import { makeNonce } from "../../shared/webviewHtml.js";
import { getStartupProjectFsPath, onDidChangeLaunchProfileState } from "../launchProfiles/launchProfileState.js";
import { SolutionFileSearchStatus, SolutionTreeDataProvider } from "../tree/solutionTreeDataProvider.js";
import { SolutionExplorerTreeItem } from "../tree/treeItems.js";
import {
  getBuildConfiguration,
  onDidChangeBuildConfiguration,
  setBuildConfiguration,
} from "./buildConfigurationState.js";
import { mergeBuildConfigurations, parseDeclaredConfigurations } from "./buildConfigurations.js";

/**
 * One slim row docked above the Solution Explorer that recreates Visual Studio's common toolbar
 * and search-in-explorer in a single control bar: ▶ Start, the build-configuration dropdown, and a
 * file filter box that live-filters the tree below (only files whose name contains the text stay,
 * with the folders that lead to them revealed) — exactly how VS's own Solution Explorer search
 * behaves, without a second panel.
 */

/** The single toolbar/search view id (contributed first in the activity-bar container). */
export const RUN_CONTROLS_VIEW_ID = "csharpSolutionExplorer.runControlsView";
/** Clears an active file filter (title-bar ✕ and the bar's own ✕/Esc). */
export const CLEAR_FILE_SEARCH_COMMAND_ID = "csharpSolutionExplorer.search.clear";
/** Context key set while the file filter is active; drives the title-bar clear button. */
export const SEARCH_ACTIVE_CONTEXT_KEY = "csharpSolutionExplorer.searchActive";
/** Opens the build-configuration picker (editor title bar / command palette, VS-style). */
export const SELECT_BUILD_CONFIGURATION_COMMAND_ID = "csharpSolutionExplorer.selectBuildConfiguration";
/** The extension's own F5 path — debugs the startup project (falls back to VS Code's start when off). */
const START_DEBUG_COMMAND = "csharpSolutionExplorer.debug.start";
/** How many matching files to auto-expand at once, so a very broad filter cannot stall the tree. */
const MAX_AUTO_EXPANDED_MATCHES = 200;

export function registerRunControls(
  context: vscode.ExtensionContext,
  provider: SolutionTreeDataProvider,
  treeView: vscode.TreeView<SolutionExplorerTreeItem>,
): void {
  function applyFilter(text: string): void {
    provider.setSearchFilter(text);
    if (!text.trim()) {
      bar.setFilter("");
    }
  }

  const bar = new RunAndSearchViewProvider((text) => applyFilter(text));
  const subscriptions = context.subscriptions;

  subscriptions.push(
    vscode.window.registerWebviewViewProvider(RUN_CONTROLS_VIEW_ID, bar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand(CLEAR_FILE_SEARCH_COMMAND_ID, () => applyFilter("")),
    vscode.commands.registerCommand(SELECT_BUILD_CONFIGURATION_COMMAND_ID, () => void pickBuildConfiguration()),
  );

  // Search/filter status → the tree's message line and the searchActive context key.
  const onSearchStatus = (status: SolutionFileSearchStatus): void => {
    void vscode.commands.executeCommand("setContext", SEARCH_ACTIVE_CONTEXT_KEY, status.query !== "");
    if (status.state === "cleared") {
      treeView.message = undefined;
      return;
    }
    if (status.state === "building") {
      treeView.message = "Searching files…";
      return;
    }
    // ready
    treeView.message =
      status.matchCount === 0 && status.query ? `No files match "${status.query}".` : undefined;
    if (!status.query) {
      bar.setFilter("");
    }
    void revealMatches(provider, treeView);
  };
  provider.onDidChangeSearchStatus(onSearchStatus, undefined, subscriptions);

  // Recompute the dropdown whenever the startup project (its <Configurations>) or the persisted
  // choice changes; the view renders whatever the host reports.
  const refreshState = (): void => void pushState(bar);
  onDidChangeLaunchProfileState(refreshState, undefined, subscriptions);
  onDidChangeBuildConfiguration(refreshState, undefined, subscriptions);
}

/** Configurations declared by the current startup project ([] when none is set or readable). */
async function readDeclaredConfigurations(): Promise<string[]> {
  const startup = getStartupProjectFsPath();
  if (!startup) {
    return [];
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(startup));
    return parseDeclaredConfigurations(new TextDecoder().decode(bytes));
  } catch {
    return []; // a project that cannot be read simply contributes no declared configurations
  }
}

/** Reads the current selection's declared configurations and pushes the full control state. */
async function pushState(bar: RunAndSearchViewProvider): Promise<void> {
  const startup = getStartupProjectFsPath();
  bar.update({
    configurations: mergeBuildConfigurations(await readDeclaredConfigurations()),
    current: getBuildConfiguration(),
    startupName: startup ? path.basename(startup, path.extname(startup)) : undefined,
  });
}

/** VS-style configuration picker, reachable from the editor title bar and the command palette. */
async function pickBuildConfiguration(): Promise<void> {
  const items = mergeBuildConfigurations(await readDeclaredConfigurations());
  const picked = await vscode.window.showQuickPick(items, {
    title: "Select Build Configuration",
    placeHolder: `Current: ${getBuildConfiguration()}`,
  });
  if (picked) {
    setBuildConfiguration(picked);
  }
}

/**
 * Reveals (and thereby expands) every match. Repeats a few passes because a reveal only succeeds
 * once the view knows the node — and expanding one ancestor registers the next level for the pass
 * after. Best-effort: failures are ignored and the tree stays correct either way.
 */
async function revealMatches(
  provider: SolutionTreeDataProvider,
  treeView: vscode.TreeView<SolutionExplorerTreeItem>,
): Promise<void> {
  const leaves: (SolutionExplorerTreeItem | undefined)[] = provider
    .getSearchMatchLeaves()
    .slice(0, MAX_AUTO_EXPANDED_MATCHES);
  for (let round = 0; round < 5 && leaves.length > 0; round++) {
    let remaining = 0;
    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i];
      if (!leaf) {
        continue;
      }
      leaves[i] = undefined; // revealed or failed-to-reveal; only retried if it can still be placed
      try {
        await treeView.reveal(leaf, { expand: true, focus: false, select: false });
      } catch {
        remaining++;
        leaves[i] = leaf; // not yet known to the view — retry on the next pass
      }
    }
    if (remaining === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

interface RunAndSearchState {
  configurations: string[];
  current: string;
  startupName?: string;
}

/**
 * The bar itself: ▶ starts the startup project under the debugger, the select picks the build
 * configuration, and the filter box reports its text so the tree filters live (VS-style).
 * Extension ↔ view messaging in both directions; the host is always the source of truth.
 */
class RunAndSearchViewProvider implements vscode.WebviewViewProvider {
  private webviewView: vscode.WebviewView | undefined;

  constructor(private readonly onFilterText: (text: string) => void) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    webviewView.webview.html = buildRunAndSearchHtml();
    webviewView.webview.onDidReceiveMessage((message: { type?: string; value?: string }) => {
      if (message.type === "start") {
        void vscode.commands.executeCommand(START_DEBUG_COMMAND);
      } else if (message.type === "config" && message.value !== undefined) {
        setBuildConfiguration(message.value);
      } else if (message.type === "filter" && message.value !== undefined) {
        this.onFilterText(message.value);
      }
    });
    void pushState(this);
  }

  /** Host → view full-state push (configurations, current selection, startup name). */
  update(state: RunAndSearchState): void {
    this.webviewView?.webview.postMessage({ type: "state", ...state });
  }

  /** Host → view: clear the filter input (after Esc/✕/title-bar clear). */
  setFilter(text: string): void {
    this.webviewView?.webview.postMessage({ type: "filterText", text });
  }
}

function buildRunAndSearchHtml(): string {
  const nonce = makeNonce();
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style nonce="${nonce}">
  body {
    margin: 0;
    padding: 4px 8px 6px 8px;
    box-sizing: border-box;
    background: transparent;
  }
  #row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  #start {
    flex: 0 0 auto;
    width: 24px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 2px;
    background: transparent;
    color: #89d185;
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
  }
  #start:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  #startup {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--vscode-descriptionForeground);
    font-size: var(--vscode-font-size);
    max-width: 26%;
  }
  select {
    flex: 0 0 auto;
    max-width: 28%;
    padding: 1px 4px;
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 2px;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    outline: none;
  }
  #divider {
    flex: 0 0 1px;
    align-self: stretch;
    margin: 2px 2px;
    background: var(--vscode-panel-border, rgba(128, 128, 128, 0.4));
  }
  #searchWrap {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 2px;
  }
  input {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    padding: 2px 6px;
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    outline: none;
  }
  input:focus {
    border-color: var(--vscode-focusBorder);
  }
  input::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }
  #clearFilter {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 2px;
    background: transparent;
    color: var(--vscode-icon-foreground);
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
  }
  #clearFilter:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  #clearFilter[hidden] {
    display: none;
  }
</style>
</head>
<body>
  <div id="row">
    <button id="start" title="Start (debug the startup project)">&#9654;</button>
    <span id="startup">Startup project not set</span>
    <select id="config" aria-label="Build configuration"></select>
    <span id="divider"></span>
    <span id="searchWrap">
      <input id="filter" type="text" placeholder="Filter files (like Visual Studio)" spellcheck="false" autocomplete="off" />
      <button id="clearFilter" title="Clear search (Esc)" hidden>&#10005;</button>
    </span>
  </div>
<script nonce="${nonce}">
  (() => {
    const vscode = acquireVsCodeApi();
    const start = document.getElementById("start");
    const startup = document.getElementById("startup");
    const config = document.getElementById("config");
    const filter = document.getElementById("filter");
    const clearFilter = document.getElementById("clearFilter");
    const DEBOUNCE_MS = 120;
    let timer;

    start.addEventListener("click", () => vscode.postMessage({ type: "start" }));
    config.addEventListener("change", () => vscode.postMessage({ type: "config", value: config.value }));

    function setFilterValue(text) {
      filter.value = text || "";
      clearFilter.hidden = filter.value === "";
    }
    function reportFilter() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => vscode.postMessage({ type: "filter", value: filter.value }), DEBOUNCE_MS);
    }
    function clearInput() {
      setFilterValue("");
      if (timer) clearTimeout(timer);
      vscode.postMessage({ type: "filter", value: "" });
      filter.focus();
    }
    filter.addEventListener("input", () => {
      clearFilter.hidden = filter.value === "";
      reportFilter();
    });
    filter.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        clearInput();
      }
    });
    clearFilter.addEventListener("click", clearInput);

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message) return;
      if (message.type === "state") {
        config.innerHTML = "";
        for (const name of message.configurations || []) {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name;
          option.selected = name === message.current;
          config.appendChild(option);
        }
        startup.textContent = message.startupName ? message.startupName : "Startup project not set";
      } else if (message.type === "filterText") {
        setFilterValue(message.text || "");
      }
    });
  })();
</script>
</body>
</html>`;
}
