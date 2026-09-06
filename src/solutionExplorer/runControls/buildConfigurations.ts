// Pure build-configuration helpers for the run toolbar. Kept free of `vscode` imports so the
// parsing/merge rules are unit-testable without an extension host.

/** The configurations offered even when no project declares any. */
export const DEFAULT_BUILD_CONFIGURATIONS: readonly string[] = ["Debug", "Release"];

const CONFIGURATIONS_ELEMENT_PATTERN = /<Configurations[^>]*>([^<]*)<\/Configurations>/i;

/**
 * The configurations a project declares via `<Configurations>Debug;Release</Configurations>`
 * (the MSBuild property the .NET SDK templates use; a project that omits it builds with whatever
 * the caller asks for). Returns [] when none is declared.
 */
export function parseDeclaredConfigurations(csprojText: string): string[] {
  const raw = CONFIGURATIONS_ELEMENT_PATTERN.exec(csprojText)?.[1];
  if (!raw) {
    return [];
  }
  return raw
    .split(/[;,]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** The dropdown list: declared configurations plus the Debug/Release defaults, de-duplicated. */
export function mergeBuildConfigurations(declared: readonly string[]): string[] {
  return [...new Set([...DEFAULT_BUILD_CONFIGURATIONS, ...declared])];
}
