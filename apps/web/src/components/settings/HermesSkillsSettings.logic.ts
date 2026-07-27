import type {
  HermesSkillsProviderProjection,
  HermesSkillsReloadResponse,
} from "@t3tools/contracts";

export function formatSkillsReloadSummary(result: HermesSkillsReloadResponse): string {
  const parts = [`${result.added.length} added`, `${result.removed.length} removed`];
  if (result.total !== null) parts.push(`${result.total} total`);
  return parts.join(", ");
}

export function formatSkillNames(names: ReadonlyArray<string>): string | null {
  return names.length === 0 ? null : names.join(", ");
}

export function skillsBlockedDiagnostic(provider: HermesSkillsProviderProjection): string | null {
  if (provider.status === "ready") return null;
  return provider.diagnostics[0] ?? "Hermes skills are unavailable for this provider.";
}
