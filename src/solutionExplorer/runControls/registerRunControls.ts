import * as path from "node:path";
import * as vscode from "vscode";
import { makeNonce } from "../../shared/webviewHtml.js";
import { getStartupProjectFsPath, onDidChangeLaunchProfileState } from "../launchProfiles/launchProfileState.js";
import {
  getBuildConfiguration,
  onDidChangeBuildConfiguration,
  setBuildConfiguration,
} from "./buildConfigurationState.js";
import { mergeBuildConfigurations, parseDeclaredConfigurations } from "./buildConfigurations.js";

/** The slim run toolbar docked above the Solution Explorer in the same activity-bar container. */
export const RUN_CONTROLS_VIEW_ID = "csharpSolutionExplorer.runControlsView";
/** The extension's own F5 path — debugs the startup project (falls back to VS Code's F5 when off). */
const START_DEBUG_COMMAND = "csharpSolutionExplorer.debug.start";

/**
 * Registers the Visual Studio-style run toolbar: a ▶ Start button and a build-configuration
 * dropdown (Debug / Release / whatever the projects declare). The dropdown's choice is persisted
 * per workspace and feeds `-c` into every build/run/debug the tree starts.
 */
export function registerRunControls(context: vscode.ExtensionContext): void {
  const bar = new RunControlsViewProvider();
  const subscriptions = context.subscriptions;

  subscriptions.push(vscode.window.registerWebviewViewProvider(RUN_CONTROLS_VIEW_ID, bar, {
    webviewOptions: { retainContextWhenHidden: true },
  }));

  // Refresh the dropdown whenever the startup project (its <Configurations>) or the persisted
  // choice changes; the view itself re-renders whatever the host reports.
  const refresh = (): void => void pushState(bar);
  onDidChangeLaunchProfileState(refresh, undefined, subscriptions);
  onDidChangeBuildConfiguration(refresh, undefined, subscriptions);
}

/** Reads the current selection's declared configurations and pushes the full control state. */
async function pushState(bar: RunControlsViewProvider): Promise<void> {
  const startup = getStartupProjectFsPath();
  let declared: string[] = [];
  if (startup) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(startup));
      declared = parseDeclaredConfigurations(new TextDecoder().decode(bytes));
    } catch {
      // A project that cannot be read simply contributes no declared configurations.
    }
  }
  bar.update({
    configurations: mergeBuildConfigurations(declared),
    current: getBuildConfiguration(),
    startupName: startup ? path.basename(startup, path.extname(startup)) : undefined,
  });
}

/**
 * The toolbar itself: ▶ starts the startup project under the debugger (Visual Studio's green
 * arrow), the select picks the build configuration, and a short label shows which project will
 * start. Messages flow both ways exactly like the search bar next to it.
 */
class RunControlsViewProvider implements vscode.WebviewViewProvider {
  private webviewView: vscode.WebviewView | undefined;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    webviewView.webview.html = buildRunToolbarHtml();
    webviewView.webview.onDidReceiveMessage((message: { type?: string; value?: string }) => {
      if (message.type === "start") {
        void vscode.commands.executeCommand(START_DEBUG_COMMAND);
      } else if (message.type === "config" && message.value !== undefined) {
        setBuildConfiguration(message.value);
      }
    });
    void pushState(this);
  }

  update(state: { configurations: string[]; current: string; startupName?: string }): void {
    this.webviewView?.webview.postMessage({ type: "state", ...state });
  }
}

function buildRunToolbarHtml(): string {
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
    padding: 4px 8px 0 8px;
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
  }
  select {
    flex: 0 1 auto;
    max-width: 45%;
    margin: 0 0 0 auto;
    padding: 1px 4px;
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 2px;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    outline: none;
  }
</style>
</head>
<body>
  <div id="row">
    <button id="start" title="Start (debug the startup project)">&#9654;</button>
    <span id="startup">Startup project not set</span>
    <select id="config" aria-label="Build configuration"></select>
  </div>
<script nonce="${nonce}">
  (() => {
    const vscode = acquireVsCodeApi();
    const start = document.getElementById("start");
    const startup = document.getElementById("startup");
    const config = document.getElementById("config");

    start.addEventListener("click", () => vscode.postMessage({ type: "start" }));
    config.addEventListener("change", () => vscode.postMessage({ type: "config", value: config.value }));

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || message.type !== "state") return;
      config.innerHTML = "";
      for (const name of message.configurations || []) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        option.selected = name === message.current;
        config.appendChild(option);
      }
      startup.textContent = message.startupName ? message.startupName : "Startup project not set";
    });
  })();
</script>
</body>
</html>`;
}
