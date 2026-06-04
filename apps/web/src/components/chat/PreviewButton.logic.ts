import type { AuthSessionRole } from "@t3tools/contracts";

export function shouldOpenPreviewInNewTab(input: {
  readonly currentSessionRole: AuthSessionRole | null;
}): boolean {
  return input.currentSessionRole === "client";
}
