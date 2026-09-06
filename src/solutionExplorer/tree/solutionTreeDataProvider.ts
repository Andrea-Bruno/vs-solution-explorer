import * as vscode from "vscode";
import { DependencyTreeResolver } from "./dependencyTree.js";
import { ProjectFileTreeBuilder } from "./projectFileTree.js";
import { getProjectItems, getRootItems, nodesToTreeItems } from "./solutionNodes.js";
import { findTreeItem } from "./treeReveal.js";
import { matchesFileName, normalizeSearchQuery } from "../search/fileNameMatch.js";
import { parseNestedProjects } from "../parsers/slnParser.js";
import { ProjectInfo } from "../types.js";
import {
  DependenciesTreeItem,
  DependencyCategoryTreeItem,
  FileTreeItem,
  FolderTreeItem,
  NestedFileTreeItem,
  PackageReferenceTreeItem,
  ProjectReferenceTreeItem,
  ProjectTreeItem,
  SolutionExplorerTreeItem,
  SolutionFolderTreeItem,
  SolutionTreeItem,
} from "./treeItems.js";

const REFRESH_DEBOUNCE_MS = 300;

/** Progress of the file-search filter that drives the Solution Explorer while it is active. */
export interface SolutionFileSearchStatus {
  /** The active filter ("" once cleared). */
  query: string;
  state: "building" | "ready" | "cleared";
  /** Matched files in the latest completed run (0 while building or after a clear). */
  matchCount: number;
}

/**
 * A fully materialized, filtered snapshot of the tree while a file search is active. Built once per
 * query (not lazily per expanded node), so every kept node has a stable instance and a recorded
 * parent — `TreeView.reveal` can then walk each match back to the root and auto-expand it.
 */
interface SolutionFileSearchSession {
  roots: SolutionExplorerTreeItem[];
  leaves: SolutionExplorerTreeItem[];
  childrenOf: WeakMap<SolutionExplorerTreeItem, SolutionExplorerTreeItem[]>;
}

export class SolutionTreeDataProvider implements vscode.TreeDataProvider<SolutionExplorerTreeItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SolutionExplorerTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly watcher: vscode.FileSystemWatcher;
  private readonly workspaceFoldersListener: vscode.Disposable;
  private refreshTimeout: NodeJS.Timeout | undefined;

  private readonly dependencies = new DependencyTreeResolver();
  private readonly files = new ProjectFileTreeBuilder();

  /** Parent pointer per tree item, recorded as children are produced, so `getParent` (and therefore
   * `TreeView.reveal`) can walk from a leaf back up to the root. */
  private readonly parentMap = new WeakMap<SolutionExplorerTreeItem, SolutionExplorerTreeItem>();

  private readonly _onDidChangeSearchStatus = new vscode.EventEmitter<SolutionFileSearchStatus>();
  /** Reports the file-search filter's lifecycle so the view can show status and reveal matches. */
  readonly onDidChangeSearchStatus = this._onDidChangeSearchStatus.event;

  /** Active file-search filter ("" when the tree is unfiltered). */
  private searchQuery = "";
  /** Monotonic token that makes a superseded search run (typing, refresh) a no-op. */
  private searchRunId = 0;
  /** Filtered snapshot for `searchQuery`, rebuilt on every change and on refresh. */
  private searchSession: SolutionFileSearchSession | undefined;

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.watcher.onDidCreate(() => this.scheduleRefresh());
    this.watcher.onDidChange(() => this.scheduleRefresh());
    this.watcher.onDidDelete(() => this.scheduleRefresh());

    this.workspaceFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh());
  }

  private scheduleRefresh(): void {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }
    this.refreshTimeout = setTimeout(() => {
      this.files.clearCaches();
      this.dependencies.clearCaches();
      this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  refresh(): void {
    if (this.searchQuery) {
      // The tree is showing a filtered snapshot; re-run the search against the fresh data instead
      // of firing an unfiltered tree update.
      void this.runSearch(this.searchQuery);
      return;
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SolutionExplorerTreeItem): vscode.TreeItem {
    return element;
  }

  getParent(element: SolutionExplorerTreeItem): SolutionExplorerTreeItem | undefined {
    return this.parentMap.get(element);
  }

  async getChildren(element?: SolutionExplorerTreeItem): Promise<SolutionExplorerTreeItem[]> {
    if (this.searchQuery) {
      if (!element) {
        return this.searchSession?.roots ?? [];
      }
      const children = this.searchSession?.childrenOf.get(element);
      if (children) {
        for (const child of children) {
          this.parentMap.set(child, element);
        }
      }
      return children ?? [];
    }
    const children = await this.rawChildren(element);
    if (element) {
      for (const child of children) {
        this.parentMap.set(child, element);
      }
    }
    return children;
  }

  /**
   * Applies a file-name filter to the Solution Explorer, Visual Studio style: while the filter is
   * non-empty the tree shows only files whose name matches (with the containers that lead to them),
   * and `getSearchMatchLeaves` exposes the matches for auto-expansion. An empty filter restores the
   * full tree.
   */
  setSearchFilter(filter: string): void {
    const query = normalizeSearchQuery(filter);
    if (query === this.searchQuery) {
      return;
    }
    this.searchQuery = query;
    if (!query) {
      this.searchRunId++;
      this.searchSession = undefined;
      this._onDidChangeSearchStatus.fire({ query: "", state: "cleared", matchCount: 0 });
      this._onDidChangeTreeData.fire();
      return;
    }
    void this.runSearch(query);
  }

  /** The matched file items of the current search, for auto-expansion via `TreeView.reveal`. */
  getSearchMatchLeaves(): SolutionExplorerTreeItem[] {
    return this.searchSession?.leaves ?? [];
  }

  private async runSearch(query: string): Promise<void> {
    const runId = ++this.searchRunId;
    this._onDidChangeSearchStatus.fire({ query, state: "building", matchCount: 0 });
    try {
      const session = await this.buildSearchSession(query);
      if (runId !== this.searchRunId) {
        return; // a newer filter or refresh superseded this run
      }
      this.searchSession = session;
      this._onDidChangeSearchStatus.fire({ query, state: "ready", matchCount: session.leaves.length });
      this._onDidChangeTreeData.fire();
    } catch {
      if (runId !== this.searchRunId) {
        return;
      }
      // Keep whatever the tree last showed rather than dropping into an empty state; a refresh or
      // a clear recovers.
      this._onDidChangeSearchStatus.fire({ query, state: "ready", matchCount: 0 });
    }
  }

  /**
   * Walks the whole (unfiltered) tree once and keeps only the branches that lead to a matching
   * file, snapshotting the result so nodes are stable across `getChildren` calls. Containers that
   * can never contain files (Dependencies and its sub-trees) are pruned without being walked.
   */
  private async buildSearchSession(query: string): Promise<SolutionFileSearchSession> {
    const session: SolutionFileSearchSession = {
      roots: [],
      leaves: [],
      childrenOf: new WeakMap<SolutionExplorerTreeItem, SolutionExplorerTreeItem[]>(),
    };

    const keepChildren = async (
      rawChildren: SolutionExplorerTreeItem[],
      parent: SolutionExplorerTreeItem | undefined,
    ): Promise<SolutionExplorerTreeItem[]> => {
      const kept: SolutionExplorerTreeItem[] = [];
      for (const child of rawChildren) {
        if (child instanceof FileTreeItem) {
          if (matchesFileName(query, child.entry.name)) {
            kept.push(child);
            session.leaves.push(child);
            if (parent) {
              this.parentMap.set(child, parent);
            }
          }
          continue;
        }
        if (!isSearchableContainer(child)) {
          continue;
        }
        const keptChildren = await keepChildren(await this.rawChildren(child), child);
        // A nesting parent (e.g. Page.xaml next to Page.xaml.cs) is itself a file: keep it when its
        // own name matches as well as when a companion does.
        const ownNameMatches =
          child instanceof NestedFileTreeItem && matchesFileName(query, child.entry.name);
        if (keptChildren.length > 0 || ownNameMatches) {
          if (ownNameMatches) {
            session.leaves.push(child);
          }
          kept.push(child);
          session.childrenOf.set(child, keptChildren);
          if (parent) {
            this.parentMap.set(child, parent);
          }
        }
      }
      return kept;
    };

    session.roots = await keepChildren(await this.rawChildren(undefined), undefined);
    return session;
  }

  private async rawChildren(element?: SolutionExplorerTreeItem): Promise<SolutionExplorerTreeItem[]> {
    if (!element) {
      return getRootItems();
    }
    if (element instanceof SolutionTreeItem) {
      return getProjectItems(element.info);
    }
    if (element instanceof SolutionFolderTreeItem) {
      const nesting = element.info.isVirtual
        ? new Map<string, string>()
        : parseNestedProjects(new TextDecoder().decode(await vscode.workspace.fs.readFile(element.info.solutionUri)));
      return nodesToTreeItems(
        element.info.children,
        element.info.solutionDir,
        element.info.solutionUri,
        nesting,
        element.info.stableId,
      );
    }
    if (element instanceof ProjectTreeItem) {
      return this.getProjectChildren(element.info);
    }
    if (element instanceof DependenciesTreeItem) {
      const info = await this.dependencies.getDependenciesInfo(element.project);
      return this.dependencies.getDependencyCategories(info);
    }
    if (element instanceof DependencyCategoryTreeItem) {
      return this.dependencies.getCategoryChildren(element.info.category, element.info.dependencies);
    }
    if (element instanceof PackageReferenceTreeItem) {
      return (element.info.dependencies ?? []).map((info) => new PackageReferenceTreeItem(info));
    }
    if (element instanceof ProjectReferenceTreeItem) {
      return this.dependencies.expandProjectReference(element.info);
    }
    if (element instanceof FolderTreeItem) {
      return this.files.getFsChildren(element.entry.uri, element.projectRootUri, element.excludedPaths);
    }
    if (element instanceof NestedFileTreeItem) {
      return element.companions.map((c) => new FileTreeItem(c));
    }
    return [];
  }

  /**
   * Resolves the tree item for a file/folder URI by walking the live tree from the roots down, so the
   * returned instance (and its recorded parents) can be handed to `TreeView.reveal`. Returns
   * `undefined` when the path lies outside every project. Populates `parentMap` along the way.
   */
  async findTreeItem(uri: vscode.Uri): Promise<SolutionExplorerTreeItem | undefined> {
    return findTreeItem((element) => this.getChildren(element), uri);
  }

  private async getProjectChildren(info: ProjectInfo): Promise<SolutionExplorerTreeItem[]> {
    const excludedPaths = await this.files.getExcludedPaths(info);
    // Hide the project's own .csproj from the file list; it's opened via the node's
    // "Open in Editor" context-menu command instead of appearing as a child file.
    return [
      new DependenciesTreeItem(info),
      ...this.files.getFsChildren(info.rootDir, info.rootDir, excludedPaths, info.uri.fsPath),
    ];
  }

  dispose(): void {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }
    this.watcher.dispose();
    this.workspaceFoldersListener.dispose();
    this._onDidChangeTreeData.dispose();
    this._onDidChangeSearchStatus.dispose();
  }
}

/** Containers whose descendants can contain files. Every other item kind (Dependencies and its
 * sub-trees) is file-free and dropped from a search without being walked. */
function isSearchableContainer(item: SolutionExplorerTreeItem): boolean {
  return (
    item instanceof SolutionTreeItem ||
    item instanceof SolutionFolderTreeItem ||
    item instanceof ProjectTreeItem ||
    item instanceof FolderTreeItem ||
    item instanceof NestedFileTreeItem
  );
}
