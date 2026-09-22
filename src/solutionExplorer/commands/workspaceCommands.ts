import * as path from "node:path";
import * as vscode from "vscode";
import { findWorkspaceSolutions, listSolutionProjects } from "../../nuget/nugetManagerService.js";
import { SolutionTreeItem } from "../tree/treeItems.js";

function toComparable(p: string): string {
  const normalized = path.normalize(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** True when `child` equals `ancestor` or sits somewhere below it. */
function isSameOrBelow(child: string, ancestor: string): boolean {
  const rel = path.relative(ancestor, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * "Open Solution as Multi-Root Workspace": writes a `.code-workspace` next to the solution whose
 * folders are the directories of every project in the solution (plus the solution's own folder
 * when the projects live outside it, e.g. sibling repositories), then offers to reload VS Code
 * into it. A solution is a set of projects that often spans several folders/repositories — a
 * multi-root workspace makes that the VS Code reality instead of one project folder per window.
 */
export async function openSolutionAsWorkspace(item: unknown): Promise<void> {
  // Resolve the solution: the right-clicked solution node when present, otherwise pick from the
  // solutions found in the workspace (the same fallback as the NuGet Package Manager).
  let solutionUri = item instanceof SolutionTreeItem ? item.info.uri : undefined;
  if (!solutionUri) {
    const solutions = await findWorkspaceSolutions();
    if (solutions.length === 0) {
      vscode.window.showInformationMessage(
        "Open Solution as Multi-Root Workspace needs a solution (.sln/.slnx), but none was found in this workspace.",
      );
      return;
    }
    solutionUri =
      solutions.length === 1
        ? solutions[0]
        : (
            await vscode.window.showQuickPick(
              solutions.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
              { placeHolder: "Select the solution to open as a workspace" },
            )
          )?.uri;
  }
  if (!solutionUri) {
    return; // dismissed
  }

  // One folder per project directory (existing projects only — stale .sln entries are skipped).
  const solutionDir = path.normalize(path.dirname(solutionUri.fsPath));
  const projectDirs = (await listSolutionProjects(solutionUri)).map((project) =>
    path.normalize(path.dirname(project.csprojUri.fsPath)),
  );
  const unique = new Map<string, string>();
  for (const dir of projectDirs) {
    unique.set(toComparable(dir), dir);
  }

  // A folder nested in another selected folder would only duplicate the tree — keep the outermost.
  const all = [...unique.values()];
  const topLevel = all.filter((dir) => all.every((other) => other === dir || !isSameOrBelow(dir, other)));

  // When every project lives under the solution's own folder a single root (the solution folder)
  // is what the file should say; when projects sit outside it (sibling repositories) the solution
  // folder is added too, so the solution home is not lost from the workspace.
  let roots = topLevel;
  if (roots.length === 0 || !roots.every((dir) => isSameOrBelow(dir, solutionDir))) {
    if (!roots.some((dir) => toComparable(dir) === toComparable(solutionDir))) {
      roots = [...roots, solutionDir];
    }
  } else {
    roots = [solutionDir];
  }
  roots.sort((a, b) => a.localeCompare(b));

  const baseName = path.basename(solutionUri.fsPath, path.extname(solutionUri.fsPath));
  const workspaceFile = path.join(solutionDir, `${baseName}.code-workspace`);
  const workspaceDoc = {
    folders: roots.map((dir) => ({ path: dir.split(path.sep).join("/") })),
    settings: {},
  };
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(workspaceFile),
    Buffer.from(JSON.stringify(workspaceDoc, null, 2) + "\n", "utf8"),
  );

  const plural = roots.length === 1 ? "" : "s";
  const open = await vscode.window.showInformationMessage(
    `Created ${vscode.workspace.asRelativePath(vscode.Uri.file(workspaceFile))} with ${roots.length} workspace folder${plural}. Reload this window into it?`,
    "Open Workspace",
  );
  if (open === "Open Workspace") {
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspaceFile));
  }
}

const AUTO_INCLUDE_SETTING = "csharpSolutionExplorer.workspace.autoIncludeProjectFolders";

/**
 * "Auto-include project folders": with `csharpSolutionExplorer.workspace.autoIncludeProjectFolders`
 * on (the default), every project directory of the solution(s) in the workspace that is not already
 * inside a workspace folder is added as a workspace folder. A solution often pulls in shared projects
 * that live outside the opened folder (sibling folders, other repositories); making each one a
 * workspace root means search, source control, coding agents and the language server treat the whole
 * solution as part of the workspace, with no "outside the workspace" boundary.
 *
 * Runs at activation and again when the setting is turned on. It only adds directories that are
 * neither inside nor an ancestor of an existing workspace folder, so it is idempotent: the
 * `onDidChangeWorkspaceFolders` event its own additions trigger never finds anything new to add.
 */
export async function autoIncludeSolutionProjectFolders(
  context: vscode.ExtensionContext,
): Promise<void> {
  const enabled = (): boolean =>
    vscode.workspace.getConfiguration().get<boolean>(AUTO_INCLUDE_SETTING, true);

  const run = async (): Promise<void> => {
    if (!enabled()) {
      return;
    }
    try {
      const solutions = await findWorkspaceSolutions();
      if (solutions.length === 0) {
        return;
      }

      const existing = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
      // Skip a directory already inside a workspace folder, or one that would wrap an existing root and
      // reshape the tree.
      const skip = (dir: string): boolean =>
        existing.some((f) => isSameOrBelow(dir, f) || isSameOrBelow(f, dir));

      const candidates = new Map<string, string>();
      for (const solution of solutions) {
        for (const project of await listSolutionProjects(solution)) {
          const dir = path.normalize(path.dirname(project.csprojUri.fsPath));
          if (!skip(dir)) {
            candidates.set(toComparable(dir), dir);
          }
        }
      }
      if (candidates.size === 0) {
        return;
      }

      // Drop a candidate nested under another candidate — keep the outermost, like the manual command.
      const all = [...candidates.values()];
      const topLevel = all.filter((dir) => all.every((other) => other === dir || !isSameOrBelow(dir, other)));
      topLevel.sort((a, b) => a.localeCompare(b));

      const startIndex = vscode.workspace.workspaceFolders?.length ?? 0;
      const added = vscode.workspace.updateWorkspaceFolders(
        startIndex,
        0,
        ...topLevel.map((dir) => ({ uri: vscode.Uri.file(dir) })),
      );
      if (!added) {
        return;
      }
      const plural = topLevel.length === 1 ? "" : "s";
      void vscode.window.showInformationMessage(
        `Added ${topLevel.length} shared project folder${plural} outside the opened folder to the workspace. Turn this off with "${AUTO_INCLUDE_SETTING}".`,
      );
    } catch {
      // Best-effort: a solution that cannot be read must not disrupt activation or the setting toggle.
    }
  };

  void run();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(AUTO_INCLUDE_SETTING)) {
        void run();
      }
    }),
  );
}
