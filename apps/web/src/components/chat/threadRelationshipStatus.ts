import type { AgentOrbState } from "./AgentOrb";

/** The short status word a Lineage row shows when it has no time to show. */
export function relationshipStatusLabel(status: string | null): string {
  switch (status) {
    case "preparing":
    case "starting":
      return "Starting";
    case "running":
    case "in_progress":
      return "Running";
    case "pending":
    case "queued":
      return "Queued";
    case "waiting":
    case "blocked":
      return "Waiting";
    case "completed":
      return "Done";
    case "failed":
    case "error":
      return "Failed";
    case "cancelled":
    case "interrupted":
      return "Stopped";
    case "rolled_back":
      return "Reverted";
    case "resolved_native":
      return "Resolved (native)";
    case "resolved_portable":
      return "Resolved (portable)";
    case "consumed":
      return "Consumed";
    case "superseded":
      return "Superseded";
    case "idle":
      return "Idle";
    default:
      return "Unknown";
  }
}

export function relationshipOrbState(status: string | null): AgentOrbState {
  if (status === "running" || status === "in_progress") return "active";
  if (status === "failed" || status === "error") return "failed";
  if (status === "completed") return "done";
  return "idle";
}
