import type { ComposerSubmissionIntent } from "../../composer-logic";
import type { SessionPhase } from "../../types";

export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

/**
 * One policy seam for the active-turn action. `activeTurnDefault` is the
 * user's `followUpBehavior`; the alternate shortcut picks the other of
 * queue/steer, so both stay one keystroke away whichever is the default.
 */
export function resolveComposerDispatchMode(input: {
  readonly phase: SessionPhase;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
}): ComposerDispatchMode {
  if (input.phase !== "running") return "auto";
  const activeTurnDefault = input.activeTurnDefault ?? "queue";
  if (input.alternateModifier) return activeTurnDefault === "steer" ? "queue" : "steer";
  return activeTurnDefault;
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
