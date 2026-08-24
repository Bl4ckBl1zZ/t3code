import type { ComposerSubmissionIntent } from "../../composer-logic";
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

/**
 * What a composer submit carries beyond the text: where the turn goes on this
 * thread (`dispatchMode`) and, for a draft, whether the new thread opens in
 * front of the user or starts in the background (`submissionIntent`).
 */
export interface ComposerSubmitOptions {
  readonly dispatchMode?: ComposerDispatchMode;
  readonly submissionIntent?: ComposerSubmissionIntent;
}
