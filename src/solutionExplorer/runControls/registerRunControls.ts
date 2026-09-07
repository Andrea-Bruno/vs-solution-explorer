import * as path from "node:path";
import * as vscode from "vscode";
import { makeNonce } from "../../shared/webviewHtml.js";
import { getStartupProjectFsPath, onDidChangeLaunchProfileState } from "../launchProfiles/launchProfileState.js";
import { SolutionFileSearchStatus, SolutionTreeDataProvider } from "../tree/solutionTreeDataProvider.js";
import { SolutionExplorerTreeItem } from "../tree/treeItems.js";
import { REVEAL_IN_TREE_COMMAND_ID } from "../types.js";
import {
  getBuildConfiguration,
  onDidChangeBuildConfiguration,
  setBuildConfiguration,
} from "./buildConfigurationState.js";
import { mergeBuildConfigurations, parseDeclaredConfigurations } from "./buildConfigurations.js";

/**
 * Two slim rows docked above the Solution Explorer that recreate Visual Studio's common toolbar and
 * its search-in-explorer: the top row carries ▶ Start and the build-configuration dropdown, the one
 * below the file filter box plus the two VS-style navigation icons — show the current file and track
 * the active item. The filter live-filters the tree below (only files whose name contains the text
 * stay, with the folders that lead to them revealed) — exactly how VS's own Solution Explorer search
 * behaves, without a second panel.
 */

/** The single toolbar/search view id (contributed first in the activity-bar container). */
export const RUN_CONTROLS_VIEW_ID = "csharpSolutionExplorer.runControlsView";
/** The Solution Explorer tree view, whose search-driven expansion must unwind when the filter clears. */
const SOLUTION_TREE_VIEW_ID = "csharpSolutionExplorer.view";
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
      // Revealing the matches expanded their branches; with the filter gone the tree must not stay
      // expanded by that search — collapse it back to its default state (Visual Studio behaviour).
      void collapseSolutionTree();
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

  // Re-sync the toggle when autoReveal changes anywhere outside the bar (Settings editor, Options
  // panel, the bar's own write in setAutoRevealSetting) — the view never assumes its own state.
  subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("csharpSolutionExplorer.autoReveal")) {
        void pushState(bar);
      }
    }),
  );
}

/** Collapses the Solution Explorer via its workbench title action; best-effort (the command
 * exists only while the view does, and a stale call must never surface an error). */
async function collapseSolutionTree(): Promise<void> {
  try {
    await vscode.commands.executeCommand(`workbench.actions.treeView.${SOLUTION_TREE_VIEW_ID}.collapseAll`);
  } catch {
    // nothing to collapse — the view is gone or the action is unavailable
  }
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
    autoReveal: vscode.workspace.getConfiguration("csharpSolutionExplorer").get<boolean>("autoReveal", true),
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
 * Writes the bar's Track Active Item toggle into the existing autoReveal setting (User scope, like
 * VS keeps its own track-active option in the user options) so the two share one state. The caller
 * re-syncs the bar afterwards; external changes (Settings editor, Options panel) come back through
 * the config-change listener.
 */
async function setAutoRevealSetting(value: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration("csharpSolutionExplorer")
    .update("autoReveal", value, vscode.ConfigurationTarget.Global);
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
  /** Track Active Item state (mirrors the autoReveal setting). */
  autoReveal: boolean;
}

/**
 * The bar itself: row one has ▶ (starts the startup project under the debugger) and the
 * build-configuration select; row two the file filter box and the two VS-style icons — Show Current
 * File (one-shot reveal in the tree) and Track Active Item (auto-reveal toggle). Extension ↔ view
 * messaging in both directions; the host is always the source of truth.
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
    webviewView.webview.onDidReceiveMessage(
      (message: { type?: string; value?: string | boolean }) => {
        if (message.type === "start") {
          void vscode.commands.executeCommand(START_DEBUG_COMMAND);
        } else if (message.type === "config" && typeof message.value === "string") {
          setBuildConfiguration(message.value);
        } else if (message.type === "filter" && typeof message.value === "string") {
          this.onFilterText(message.value);
        } else if (message.type === "revealActive") {
          void vscode.commands.executeCommand(REVEAL_IN_TREE_COMMAND_ID);
        } else if (message.type === "setAutoReveal" && typeof message.value === "boolean") {
          void setAutoRevealSetting(message.value).finally(() => pushState(this));
        }
      },
    );
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
    padding: 5px 8px 6px 8px;
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
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--vscode-descriptionForeground);
    font-size: var(--vscode-font-size);
  }
  select {
    flex: 0 0 auto;
    max-width: 45%;
    padding: 1px 4px;
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 2px;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    outline: none;
  }
  #filterRow {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 4px;
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
  .iconBtn {
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 2px;
    background: transparent;
    color: var(--vscode-icon-foreground);
    cursor: pointer;
  }
  .iconBtn:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  #trackActive.on {
    color: #89d185;
    background: var(--vscode-toolbar-hoverBackground);
  }
</style>
</head>
<body>
  <div id="row">
    <button id="start" title="Start (debug the startup project)">&#9654;</button>
    <span id="startup">Startup project not set</span>
    <select id="config" aria-label="Build configuration"></select>
  </div>
  <div id="filterRow">
    <span id="searchWrap">
      <input id="filter" type="text" placeholder="Filter files (like Visual Studio)" spellcheck="false" autocomplete="off" />
      <button id="clearFilter" title="Clear search (Esc)" hidden>&#10005;</button>
    </span>
    <button id="revealActive" class="iconBtn" title="Show Current File in Solution Explorer" aria-label="Show Current File in Solution Explorer">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M8.58594 1.00098C8.98394 1.00098 9.36646 1.15943 9.64746 1.44043L12.5605 4.35352C12.8415 4.63552 13.001 5.01704 13.001 5.41504V13.001C13.001 14.106 12.106 15.001 11.001 15.001H5.00098C3.89599 15.001 3.00098 14.106 3.00098 13.001V6.00098H4.00098V13.001C4.00098 13.553 4.44899 14.001 5.00098 14.001H11.001C11.553 14.001 12.001 13.553 12.001 13.001V6.00098H9.50098C8.67299 6.00096 8.00098 5.32897 8.00098 4.50098V2.00098C7.99198 1.97699 7.98265 1.9527 7.97266 1.92871C7.89674 1.74704 7.78717 1.5812 7.64746 1.44238L7.20605 1.00098H8.58594ZM9 4.5C9 4.776 9.224 5 9.5 5H11.793L9 2.20703V4.5Z"/><path d="M4.5 0C4.63299 0 4.75952 0.0534683 4.85352 0.147461L6.85352 2.14746C6.90042 2.19336 6.93789 2.24775 6.96289 2.30859C6.98789 2.36959 7.00097 2.43498 7.00098 2.50098C7.00098 2.56698 6.98789 2.63236 6.96289 2.69336C6.93789 2.75323 6.90043 2.80956 6.85352 2.85547L4.85352 4.85547C4.75956 4.94917 4.63278 5.00195 4.5 5.00195C4.36722 5.00195 4.24044 4.94917 4.14648 4.85547C4.05248 4.76147 3.99902 4.63398 3.99902 4.50098C3.99903 4.36799 4.05249 4.24146 4.14648 4.14746L5.29297 3.00098H2.5C2.10201 3.00098 1.72045 3.15944 1.43945 3.44043C1.15846 3.72242 1.00001 4.10298 1 4.50098V5.50098C1 5.63398 0.947516 5.76147 0.853516 5.85547C0.759563 5.94817 0.632774 6.00098 0.5 6.00098C0.367225 6.00098 0.240437 5.94917 0.146484 5.85547C0.0534844 5.76147 0 5.63398 0 5.50098V4.50098C6.17892e-06 3.83799 0.263427 3.20239 0.732422 2.7334C1.20142 2.26441 1.83701 2.00098 2.5 2.00098H5.29297L4.14648 0.855469C4.05248 0.761469 3.99902 0.633977 3.99902 0.500977C3.99903 0.367985 4.05249 0.241455 4.14648 0.147461C4.24048 0.0534683 4.36701 0 4.5 0Z"/></svg>
    </button>
    <button id="trackActive" class="iconBtn" aria-pressed="false" aria-label="Track Active Item in Solution Explorer">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M14 3.5V6.5C14 6.78 13.78 7 13.5 7H10.5C10.22 7 9.99999 6.78 9.99999 6.5C9.99999 6.22 10.22 6 10.5 6H12.58C11.78 4.17 10.01 3 7.99999 3C5.77999 3 3.79999 4.5 3.18999 6.64C3.12999 6.86 2.92999 7 2.70999 7C2.65999 7 2.61999 7 2.56999 6.98C2.29999 6.9 2.14999 6.63 2.22999 6.36C2.95999 3.79 5.32999 2 7.99999 2C10.05 2 11.91 3.02 13 4.69V3.5C13 3.22 13.22 3 13.5 3C13.78 3 14 3.22 14 3.5ZM13.42 9.02C13.16 8.95 12.88 9.1 12.8 9.37C12.19 11.51 10.22 13.01 7.98999 13.01C5.97999 13.01 4.20999 11.84 3.40999 10.01H5.48999C5.76999 10.01 5.98999 9.79 5.98999 9.51C5.98999 9.23 5.76999 9.01 5.48999 9.01H2.48999C2.20999 9.01 1.98999 9.23 1.98999 9.51V12.51C1.98999 12.79 2.20999 13.01 2.48999 13.01C2.76999 13.01 2.98999 12.79 2.98999 12.51V11.32C4.07999 12.98 5.93999 14.01 7.98999 14.01C10.66 14.01 13.03 12.22 13.76 9.65C13.84 9.38 13.68 9.11 13.41 9.03L13.42 9.02Z"/></svg>
    </button>
  </div>
<script nonce="${nonce}">
  (() => {
    const vscode = acquireVsCodeApi();
    const start = document.getElementById("start");
    const startup = document.getElementById("startup");
    const config = document.getElementById("config");
    const filter = document.getElementById("filter");
    const clearFilter = document.getElementById("clearFilter");
    const revealActive = document.getElementById("revealActive");
    const trackActive = document.getElementById("trackActive");
    const DEBOUNCE_MS = 120;
    let timer;

    start.addEventListener("click", () => vscode.postMessage({ type: "start" }));
    config.addEventListener("change", () => vscode.postMessage({ type: "config", value: config.value }));

    function setTrack(on) {
      trackActive.classList.toggle("on", on);
      trackActive.setAttribute("aria-pressed", on ? "true" : "false");
      trackActive.title = on
        ? "Stop Tracking Active Item in Solution Explorer"
        : "Track Active Item in Solution Explorer";
    }
    revealActive.addEventListener("click", () => vscode.postMessage({ type: "revealActive" }));
    trackActive.addEventListener("click", () => {
      const next = trackActive.getAttribute("aria-pressed") !== "true";
      setTrack(next);
      vscode.postMessage({ type: "setAutoReveal", value: next });
    });
    setTrack(false);

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
        setTrack(message.autoReveal === true);
      } else if (message.type === "filterText") {
        setFilterValue(message.text || "");
      }
    });
  })();
</script>
</body>
</html>`;
}
