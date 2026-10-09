import * as path from "node:path";
import * as vscode from "vscode";
import { getProjectRootDir, isLikelyCsproj } from "../parsers/csprojReader.js";
import { basenameWithoutExtension, toPosixRelative } from "../fsPathUtils.js";
import { getStartupProjectFsPath } from "../launchProfiles/launchProfileState.js";
import { buildSolutionTree, parseNestedProjects, parseSolutionFile, SolutionTreeNode } from "../parsers/slnParser.js";
import { parseSlnxFile } from "../parsers/slnxParser.js";
import { parseSolutionProjects } from "../../nuget/solutionProjects.js";
import { ProjectInfo, SolutionInfo } from "../types.js";
import {
  ProjectTreeItem,
  SolutionExplorerTreeItem,
  SolutionFolderTreeItem,
  SolutionTreeItem,
} from "./treeItems.js";

/**
 * The tree roots: every `.sln`/`.slnx` in the workspace folders, or — when a folder has no solution
 * at all — the `.csproj` files sitting directly in it (a "pseudo solution").
 *
 * A project already shown nested under a solution root is never shown again as a pseudo-solution
 * root. This matters because auto-include (and multi-root workspaces) can add a project's own
 * directory as a workspace folder; without this check that folder would list the same `.csproj` flat
 * at the root while it is also nested under its solution, duplicating every such project.
 */
export async function getRootItems(): Promise<SolutionExplorerTreeItem[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const items: SolutionExplorerTreeItem[] = [];
  // `.csproj` files already shown inside a solution root, so the pseudo-solution pass skips them.
  const coveredCsproj = new Set<string>();
  const foldersWithoutSolution: vscode.WorkspaceFolder[] = [];

  for (const folder of folders) {
    const exclude = new vscode.RelativePattern(folder, "**/{node_modules,bin,obj,.git,.vs}/**");
    const slnUris = [
      ...(await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*.sln"), exclude)),
      ...(await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*.slnx"), exclude)),
    ].sort((a, b) => a.fsPath.localeCompare(b.fsPath));

    if (slnUris.length === 0) {
      foldersWithoutSolution.push(folder);
      continue;
    }

    for (const slnUri of slnUris) {
      const relativeDir = toPosixRelative(folder.uri.fsPath, path.dirname(slnUri.fsPath));
      const info: SolutionInfo = {
        kind: "solution",
        name: basenameWithoutExtension(slnUri.fsPath),
        uri: slnUri,
        relativeDir: relativeDir || undefined,
      };
      items.push(new SolutionTreeItem(info));
      for (const key of await coveredCsprojKeys(slnUri)) {
        coveredCsproj.add(key);
      }
    }
  }

  for (const folder of foldersWithoutSolution) {
    const csprojUris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "*.csproj"));
    for (const csprojUri of csprojUris) {
      if (coveredCsproj.has(comparablePath(csprojUri.fsPath))) {
        continue;
      }
      items.push(new ProjectTreeItem(toProjectInfo(csprojUri, true, undefined, undefined)));
    }
  }

  return items;
}

/**
 * Comparable keys for every `.csproj` a solution references, resolved against the solution's own
 * directory. Returns empty when the solution cannot be read, so an unreadable file never hides a
 * pseudo-solution root.
 */
async function coveredCsprojKeys(solutionUri: vscode.Uri): Promise<string[]> {
  try {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(solutionUri));
    const isSlnx = solutionUri.fsPath.toLowerCase().endsWith(".slnx");
    const solutionDir = vscode.Uri.joinPath(solutionUri, "..");
    return parseSolutionProjects(text, isSlnx).map((project) =>
      comparablePath(vscode.Uri.joinPath(solutionDir, ...project.relativePath.split("/")).fsPath),
    );
  } catch {
    return [];
  }
}

/** A path key that compares equal regardless of separator style and, on Windows, letter case. */
function comparablePath(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Parses a solution file and turns its top-level entries into tree items. */
export async function getProjectItems(solution: SolutionInfo): Promise<SolutionExplorerTreeItem[]> {
  const bytes = await vscode.workspace.fs.readFile(solution.uri);
  const text = new TextDecoder().decode(bytes);
  const solutionDir = vscode.Uri.joinPath(solution.uri, "..");
  const nesting = parseNestedProjects(text);

  const tree = solution.uri.fsPath.toLowerCase().endsWith(".slnx")
    ? parseSlnxFile(text)
    : buildSolutionTree(parseSolutionFile(text), parseNestedProjects(text));

  return nodesToTreeItems(tree, solutionDir, solution.uri, nesting);
}

export async function nodesToTreeItems(
  nodes: SolutionTreeNode[],
  solutionDir: vscode.Uri,
  solutionUri: vscode.Uri,
  nesting: Map<string, string>,
  parentKey = "",
): Promise<SolutionExplorerTreeItem[]> {
  const items: SolutionExplorerTreeItem[] = [];
  for (const node of nodes) {
    if (node.kind === "solutionFolder") {
      items.push(
        new SolutionFolderTreeItem({
          kind: "solutionFolder",
          name: node.name,
          guid: node.guid,
          children: node.children,
          solutionDir,
          solutionUri,
          isVirtual: node.isVirtual,
          // Parent chain + guid keeps this unique even when sibling/nested folders share a name.
          stableId: `${parentKey}/${node.name}#${node.guid}`,
        }),
      );
      continue;
    }

    if (!isLikelyCsproj(node.relativePath)) {
      continue;
    }

    const csprojUri = vscode.Uri.joinPath(solutionDir, node.relativePath);
    if (!(await fileExists(csprojUri))) {
      continue;
    }

    const parentFolderGuid = nesting.get(node.guid);
    items.push(new ProjectTreeItem(toProjectInfo(csprojUri, false, node.name, solutionUri, node.guid, parentFolderGuid)));
  }

  return items;
}

export function toProjectInfo(
  csprojUri: vscode.Uri,
  isPseudoSolution: boolean,
  name: string | undefined,
  solutionUri: vscode.Uri | undefined,
  guid?: string,
  parentFolderGuid?: string,
): ProjectInfo {
  return {
    kind: "project",
    name: name ?? basenameWithoutExtension(csprojUri.fsPath),
    uri: csprojUri,
    rootDir: vscode.Uri.file(getProjectRootDir(csprojUri.fsPath)),
    isPseudoSolution,
    solutionUri,
    guid,
    parentFolderGuid,
    isStartup: csprojUri.fsPath === getStartupProjectFsPath(),
  };
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
