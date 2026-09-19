import type { EnvironmentId } from "@t3tools/contracts";

/** Folder paths only mean something to the environment running on this machine. */
export function folderDropTarget(input: {
  environmentId: EnvironmentId;
  primaryEnvironmentId: EnvironmentId | null;
}): "local" | "remote" {
  if (input.primaryEnvironmentId === null || input.environmentId !== input.primaryEnvironmentId) {
    return "remote";
  }
  return "local";
}

export function resolveDroppedFolderPath(
  folder: File,
  getPathForFile: ((file: File) => string) | undefined,
): string | null {
  const path = getPathForFile?.(folder);
  return typeof path === "string" && path.length > 0 ? path : null;
}
