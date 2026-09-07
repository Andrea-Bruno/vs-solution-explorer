[← README](../README.md)

# Context Menu Commands

| Command                  | Available on                           |
| ------------------------ | -------------------------------------- |
| New Item ▶               | Project, Folder                        |
| — New Class…             | Project, Folder                        |
| — New Interface…         | Project, Folder                        |
| — New Record…            | Project, Folder                        |
| — New Enum…              | Project, Folder                        |
| — New Struct…            | Project, Folder                        |
| — New Razor Component…   | Project, Folder                        |
| — New File…              | Project, Folder                        |
| New Folder…              | Project, Folder                        |
| New Solution Folder…     | Solution, Solution Folder              |
| New Project…             | Solution, Solution Folder              |
| Add Existing Project…    | Solution, Solution Folder              |
| Add Project Reference…   | Project, Dependencies, Projects        |
| Remove (reference)       | Project reference                      |
| Add Package…             | Project, Dependencies, Packages        |
| Update Package…          | Package                                |
| Update to Latest Version | Outdated package                       |
| Remove Package           | Package                                |
| Manage NuGet Packages…   | Solution, Project, Dependencies        |
| Set as Startup Project   | Project                                |
| Select Launch Profile…   | Project                                |
| Build                    | Project, Solution                      |
| Rebuild                  | Project, Solution                      |
| Run Project              | Project                                |
| Test                     | Project, Solution                      |
| Restore                  | Project, Solution                      |
| Clean                    | Project, Solution                      |
| Copy / Cut               | Folder, File                           |
| Paste                    | Project, Folder                        |
| Rename…                  | Project, Solution Folder, Folder, File |
| Delete                   | Project, Solution Folder, Folder, File |
| Remove from Solution     | Project                                |
| Open in Editor           | Project, Solution node                 |
| Open in Terminal         | Solution, Project, Folder              |
| Show in Finder/Explorer  | Solution, Project, Folder, File        |
| Show in Solution Explorer| Editor tab, Command Palette            |
| Properties               | Project                                |
| Options...               | View title bar, Command Palette        |
| Show Test Run Dashboard  | Command Palette                        |

## Command details

- **New Item submenu**: prompts for a name and creates the file in the target folder. The namespace is derived automatically from the project name and folder path. All templates are configurable — see [Settings](settings.md).
- **New Razor Component…**: enforces the Blazor convention that component names start with an uppercase letter.
- **New File…**: accepts any filename with extension and creates an empty file.
- **Rename**: updates the solution file entry and root folder when renaming a project or Solution Folder.
- **Delete**: moves files and folders to trash; removes the project or Solution Folder entry from the solution file.
- **Remove from Solution**: removes the project reference from the solution file without deleting files on disk.
- **New Project…**: scaffolds a new project from a `dotnet new` template (Console, Class Library, Web API, Blazor, test projects, and more), creates it in a folder next to the solution, and registers it in the `.sln`/`.slnx` file.
- **Build / Rebuild / Run / Test / Restore / Clean**: runs the matching `dotnet` command in a dedicated VS Code terminal. Build, Rebuild, Test, Restore, and Clean work on both project and solution nodes; Run is project-only. **Rebuild** uses `dotnet build --no-incremental` to force a full recompile. **Test** is the plain `dotnet test` transcript in a terminal; for per-test results, single-test runs, debugging and coverage use the [Test Explorer](test-explorer.md) in VS Code's Testing view instead.
- **Copy / Cut / Paste**: copies or moves files and folders on disk. Paste targets a folder or a project's root. Copy into a location that already has a file of that name appends a `… copy` suffix instead of overwriting; Cut moves the item and clears the clipboard.
- **Open in Terminal**: opens an integrated terminal whose working directory is the solution folder, the project root, or the selected folder.
- **Reveal in Finder / File Explorer**: opens the selected item in the operating system's file manager (Finder on macOS, File Explorer on Windows, the default file manager on Linux). The menu label matches your platform.
- **Show in Solution Explorer**: reveals and selects a file in the tree — from the editor tab's context menu or the Command Palette.
- **Open in Editor**: opens the raw `.sln`/`.slnx` (on a solution) or `.csproj` (on a project) file in the editor. The project's own `.csproj` is not listed as a child file — use this command to open it.
- **Properties**: opens the project's csproj properties, package metadata and launch profiles as an editor tab — see [Project Properties](project-properties.md).
- **Show Test Run Dashboard**: opens the live view of the current or last test run — progress, time
  estimate, failures and the slowest tests. It opens on its own when a run starts unless
  `csharpSolutionExplorer.testExplorer.dashboard` says otherwise; the command exists for reopening it
  after the tab was closed. See [Test Explorer](test-explorer.md).
- **Options...**: opens this extension's settings as an editor tab, grouped into cards with a User/Workspace switcher, search and per-setting reset. The gear icon next to it opens VS Code's built-in Settings editor instead — see [Settings](settings.md).

## Drag and drop

Projects can be dragged between Solution Folders (or to the solution root) directly in the tree. A confirmation dialog is shown before the move (`csharpSolutionExplorer.confirmMove`).

## Run & Search bar

*Fork addition.* Two compact rows above the Solution Explorer recreate Visual Studio's toolbar and
its search-in-explorer: the top row holds ▶ and the configuration dropdown, the one below the file
search box and the two VS-style navigation icons.

- **▶ Start** debugs the startup project — build, launch profile and framework are all resolved in
  memory, with no `launch.json` to create or maintain (falls back to VS Code's own start when the
  bundled debugger is disabled).
- **Configuration** dropdown picks the build configuration — Debug and Release are always offered,
  plus any extra names a project declares via `<Configurations>Debug;Release;QA</Configurations>`.
  The choice is remembered per workspace and is passed as `-c`/`--configuration` to Build, Rebuild,
  Run, Test and every debug start.
- **Show Current File** (icon on the search row) reveals and selects the file of the active editor
  in the tree on demand — the equivalent of Visual Studio's sync-with-active-document. If the file
  is not part of the solution the icon simply does nothing.
- **Track Active Item** (toggle, icon on the search row) keeps the tree in sync while you edit:
  switching to a file selects it in the tree automatically, and the tree also lands on the current
  file when you bring it to the front. It is on by default and writes the `autoReveal` setting
  (User scope), so it stays the way you left it and is also visible in Settings / Options. Turn it
  off and only the **Show Current File** icon locates files.
- Both icons carry no text — hover to see their tooltip, Visual Studio style.
- The startup project itself is chosen with **Set as Startup Project** (project context menu) or the
  ▶ status-bar item. Only runnable projects — Exe/WinExe output or a Web/Blazor WebAssembly SDK — can
  become the startup project; class libraries are refused, exactly like Visual Studio.

## Filtering the tree like Visual Studio's search

The **filter box** on the bar's second row filters the Solution Explorer live, Visual Studio style:
only files whose name contains the typed text (case-insensitive substring, extension included) stay
visible, with the folders and projects that lead to them — and matches are revealed and expanded
automatically. The search covers every file the loaded solution references, including projects
outside the opened workspace folder.

- **✕** inside the box, **Escape**, or the **Clear File Search** (✕) title-bar button clears the
  filter and restores the full tree.
- While a filter is active the tree shows a filtered snapshot; the file watcher keeps it fresh by
  re-running the search when files change.
- A "no matches" message appears under the tree when the filter finds nothing.
