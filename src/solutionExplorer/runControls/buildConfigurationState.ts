import * as vscode from "vscode";

/**
 * The workspace's chosen build configuration (Debug, Release, …) — the value behind the
 * configuration dropdown in the Solution Explorer's run toolbar and the `-c`/`--configuration`
 * passed to every build/run/debug the tree starts. Held in a module singleton, like
 * `launchProfileState.ts`, because build and debug command handlers live in different modules.
 */

/** Default configuration; also the value every path used before a configuration existed. */
export const DEFAULT_BUILD_CONFIGURATION = "Debug";

const BUILD_CONFIG_KEY = "csharpSolutionExplorer.buildConfiguration";

let workspaceState: vscode.Memento | undefined;
let configuration = DEFAULT_BUILD_CONFIGURATION;

const emitter = new vscode.EventEmitter<void>();

/** Fires whenever the build configuration changes. */
export const onDidChangeBuildConfiguration = emitter.event;

/** Hydrates the persisted value. Run once at activation, before any UI reads it. */
export function initBuildConfiguration(context: vscode.ExtensionContext): void {
  workspaceState = context.workspaceState;
  const stored = context.workspaceState.get<string>(BUILD_CONFIG_KEY)?.trim();
  if (stored) {
    configuration = stored;
  }
}

/** The active build configuration (never empty). */
export function getBuildConfiguration(): string {
  return configuration;
}

export function setBuildConfiguration(name: string): void {
  const next = name.trim() || DEFAULT_BUILD_CONFIGURATION;
  if (next === configuration) {
    return;
  }
  configuration = next;
  void workspaceState?.update(BUILD_CONFIG_KEY, next);
  emitter.fire();
}

export function disposeBuildConfiguration(): void {
  emitter.dispose();
}
