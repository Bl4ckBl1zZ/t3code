export interface DynamicToolInputPreview {
  readonly kind: "path" | "pattern";
  readonly value: string;
}

// Argument keys that native read-style tools (Read, NotebookRead, Glob, Grep,
// LS, …) use across provider adapters. Paths outrank patterns so a Grep with
// both `pattern` and `path` still previews as its pattern only when no file
// path is present.
const PREVIEW_KEYS: ReadonlyArray<{
  readonly key: string;
  readonly kind: DynamicToolInputPreview["kind"];
}> = [
  { key: "file_path", kind: "path" },
  { key: "notebook_path", kind: "path" },
  { key: "pattern", kind: "pattern" },
  { key: "path", kind: "path" },
];

export function dynamicToolInputPreview(input: unknown): DynamicToolInputPreview | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  for (const { key, kind } of PREVIEW_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return { kind, value: value.trim() };
    }
  }
  return null;
}
