import * as NodeUtil from "node:util";

export function hermesProcessDiagnostic(output: string): string {
  return NodeUtil.stripVTControlCharacters(output)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1<redacted>@")
    .replace(
      /([?&](?:token|key|api_key|access_token|refresh_token|auth|password)=)[^\s&#]+/giu,
      "$1<redacted>",
    )
    .replace(
      /((?:authorization|api[_-]?key|[\p{L}\p{N}_-]*token|secret|password)\s*[:=]\s*)[^\r\n]+/giu,
      "$1<redacted>",
    )
    .replace(/\bBearer\s+[^\s]+/giu, "Bearer <redacted>")
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/gu, "<redacted>")
    .trim()
    .slice(-1500);
}
