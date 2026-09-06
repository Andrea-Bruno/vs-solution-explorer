// Pure file-name matching for the Solution Explorer's file search. Kept free of `vscode` imports
// so the rules are unit-testable without an extension host.

/** Lowercases and trims the user's filter text for case-insensitive substring matching. */
export function normalizeSearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

/**
 * Whether `fileName` matches the user's filter. The filter is a plain, case-insensitive substring
 * of the file name (extension included), mirroring the Solution Explorer search in Visual Studio —
 * typing "Program" finds Program.cs, typing "Program.cs" narrows the same way.
 */
export function matchesFileName(filter: string, fileName: string): boolean {
  const query = normalizeSearchQuery(filter);
  return query.length === 0 || fileName.toLocaleLowerCase().includes(query);
}
