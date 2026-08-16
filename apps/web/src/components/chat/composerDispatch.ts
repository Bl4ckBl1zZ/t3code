import type { SessionPhase } from "../../types";

export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

/** One policy seam for the future configurable active-turn default action. */
export function resolveComposerDispatchMode(input: {
  readonly phase: SessionPhase;
  readonly steerModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
}): ComposerDispatchMode {
  if (input.phase !== "running") return "auto";
  if (input.steerModifier) return "steer";
  return input.activeTurnDefault ?? "queue";
}
