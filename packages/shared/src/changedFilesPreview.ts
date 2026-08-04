// Compact presentation of a turn's changed files, shared by the web timeline
// card and the mobile work-log card: which top-level scopes to headline and
// which files to show as preview chips before the full list is expanded.

export const CHANGED_FILES_PREVIEW_FILE_LIMIT = 3;
export const CHANGED_FILES_PREVIEW_SCOPE_LIMIT = 4;

export interface ChangedFilePathInput {
  readonly path: string;
}

export interface ChangedFilesScopeSummary {
  readonly label: string;
  readonly fileCount: number;
}

function pathSegments(pathValue: string): string[] {
  return pathValue
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);
}

export function changedFileName(pathValue: string): string {
  return pathSegments(pathValue).at(-1) ?? pathValue;
}

function changedFileScope(pathValue: string): string {
  const segments = pathSegments(pathValue);
  return segments.length > 1 ? (segments[0] ?? "root") : "root";
}

export function summarizeChangedFileScopes(
  files: ReadonlyArray<ChangedFilePathInput>,
  limit = CHANGED_FILES_PREVIEW_SCOPE_LIMIT,
): ChangedFilesScopeSummary[] {
  const scopes = new Map<string, { fileCount: number; firstIndex: number }>();
  files.forEach((file, index) => {
    const label = changedFileScope(file.path);
    const current = scopes.get(label);
    scopes.set(label, {
      fileCount: (current?.fileCount ?? 0) + 1,
      firstIndex: current?.firstIndex ?? index,
    });
  });

  return Array.from(scopes, ([label, scope]) => ({
    label,
    fileCount: scope.fileCount,
    firstIndex: scope.firstIndex,
  }))
    .toSorted(
      (left, right) =>
        right.fileCount - left.fileCount ||
        left.firstIndex - right.firstIndex ||
        left.label.localeCompare(right.label),
    )
    .slice(0, limit)
    .map(({ label, fileCount }) => ({ label, fileCount }));
}

export function selectChangedFilePreview<T extends ChangedFilePathInput>(
  files: ReadonlyArray<T>,
  limit = CHANGED_FILES_PREVIEW_FILE_LIMIT,
): T[] {
  const selected: T[] = [];
  const selectedPaths = new Set<string>();
  const selectedScopes = new Set<string>();

  for (const file of files) {
    const scope = changedFileScope(file.path);
    if (selectedScopes.has(scope)) {
      continue;
    }
    selected.push(file);
    selectedPaths.add(file.path);
    selectedScopes.add(scope);
    if (selected.length === limit) {
      return selected;
    }
  }

  for (const file of files) {
    if (selectedPaths.has(file.path)) {
      continue;
    }
    selected.push(file);
    if (selected.length === limit) {
      break;
    }
  }

  return selected;
}
