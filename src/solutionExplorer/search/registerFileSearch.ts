import * as vscode from "vscode";
import { makeNonce } from "../../shared/webviewHtml.js";
import { SolutionTreeDataProvider, SolutionFileSearchStatus } from "../tree/solutionTreeDataProvider.js";
import { SolutionExplorerTreeItem } from "../tree/treeItems.js";

/** The slim search-input view docked above the Solution Explorer in the same activity-bar container. */
export const FILE_SEARCH_VIEW_ID = "csharpSolutionExplorer.searchBarView";
/** Clears an active file search (title-bar button, shown only while a search is active). */
export const CLEAR_FILE_SEARCH_COMMAND_ID = "csharpSolutionExplorer.search.clear";
/** Context key set while a file search filters the tree; drives the title-bar clear button. */
export const SEARCH_ACTIVE_CONTEXT_KEY = "csharpSolutionExplorer.searchActive";

/** How many matching files to auto-expand at once, so a very broad search cannot stall the tree. */
const MAX_AUTO_EXPANDED_MATCHES = 200;

/**
 * Registers the file-search feature: the search bar view, its command, the tree-status wiring
 * (view message + auto-expansion of matches) and the `searchActive` context key.
 */
export function registerFileSearch(
  context: vscode.ExtensionContext,
  provider: SolutionTreeDataProvider,
  treeView: vscode.TreeView<SolutionExplorerTreeItem>,
): void {
  const bar = new FileSearchBarViewProvider((text) => applyFilter(text));
  const subscriptions = context.subscriptions;

  subscriptions.push(
    vscode.window.registerWebviewViewProvider(FILE_SEARCH_VIEW_ID, bar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand(CLEAR_FILE_SEARCH_COMMAND_ID, () => applyFilter("")),
  );

  provider.onDidChangeSearchStatus(
    (status) => void onSearchStatus(status),
    undefined,
    subscriptions,
  );

  function applyFilter(text: string): void {
    provider.setSearchFilter(text);
    if (!text.trim()) {
      bar.setText("");
    }
  }

  async function onSearchStatus(status: SolutionFileSearchStatus): Promise<void> {
    await vscode.commands.executeCommand("setContext", SEARCH_ACTIVE_CONTEXT_KEY, status.query !== "");
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
    await revealMatches(provider, treeView);
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
    await delay(40);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * The search bar itself: a single-line input that reports its text to the extension (debounced)
 * and a ✕ button that clears it. The input clears itself when the extension clears the search.
 */
class FileSearchBarViewProvider implements vscode.WebviewViewProvider {
  private webviewView: vscode.WebviewView | undefined;

  constructor(private readonly onFilterText: (text: string) => void) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    webviewView.webview.html = buildSearchBarHtml();
    webviewView.webview.onDidReceiveMessage((message: { type?: string; text?: string }) => {
      if (message.type === "filter") {
        this.onFilterText(message.text ?? "");
      }
    });
  }

  /** Clears the input from the extension side (title-bar ✕, workspace reload of the bar view). */
  setText(text: string): void {
    this.webviewView?.webview.postMessage({ type: "setText", text });
  }
}

function buildSearchBarHtml(): string {
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
    gap: 4px;
  }
  input {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    padding: 3px 6px;
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
  button {
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 2px;
    background: transparent;
    color: var(--vscode-icon-foreground);
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
  }
  button:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  button[hidden] {
    display: none;
  }
</style>
</head>
<body>
  <div id="row">
    <input id="query" type="text" placeholder="Search file names in the solution" spellcheck="false" autocomplete="off" />
    <button id="clear" title="Clear search" hidden>&#10005;</button>
  </div>
<script nonce="${nonce}">
  (() => {
    const vscode = acquireVsCodeApi();
    const input = document.getElementById("query");
    const clear = document.getElementById("clear");
    const DEBOUNCE_MS = 120;
    let timer;

    function report(text) {
      vscode.postMessage({ type: "filter", text });
    }
    function refreshClearButton() {
      clear.hidden = input.value === "";
    }
    function clearInput() {
      input.value = "";
      refreshClearButton();
      if (timer) clearTimeout(timer);
      report("");
      input.focus();
    }

    input.addEventListener("input", () => {
      refreshClearButton();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => report(input.value), DEBOUNCE_MS);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        clearInput();
      }
    });
    clear.addEventListener("click", clearInput);

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message && message.type === "setText") {
        input.value = message.text || "";
        refreshClearButton();
      }
    });
  })();
</script>
</body>
</html>`;
}
