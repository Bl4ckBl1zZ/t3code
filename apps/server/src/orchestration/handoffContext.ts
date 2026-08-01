/**
 * Prompt and context helpers for cross-provider handoff.
 *
 * A handoff asks the outgoing provider session to write a self-contained
 * summary of the conversation, then replays that summary to the incoming
 * provider on its first turn. Both sides are pure string builders so the
 * decider and the reactor can share them without pulling in services.
 *
 * @module handoffContext
 */
import type { ModelSelection } from "@t3tools/contracts";

/** Keeps a pathological summary from crowding out the user's own message. */
export const MAX_HANDOFF_SUMMARY_CHARS = 24_000;

export function describeModelSelection(selection: ModelSelection): string {
  return selection.instanceId === selection.model
    ? selection.model
    : `${selection.instanceId} / ${selection.model}`;
}

export function truncateHandoffSummary(
  summary: string,
  maxChars: number = MAX_HANDOFF_SUMMARY_CHARS,
): string {
  const trimmed = summary.trim();
  if (trimmed.length <= maxChars) return trimmed;
  // Keep the head: handoff summaries lead with task state and decisions, and
  // trail with lower-value detail.
  return `${trimmed.slice(0, maxChars).trimEnd()}\n\n[handoff summary truncated]`;
}

/**
 * Instruction sent to the OUTGOING session. It must answer from context
 * alone — tool calls would stall the turn behind an approval prompt, and the
 * capture path fails the handoff if a request opens.
 */
export function buildHandoffSummaryPrompt(input: {
  readonly from: ModelSelection;
  readonly to: ModelSelection;
}): string {
  return [
    `This conversation is being handed off from ${describeModelSelection(input.from)} to ${describeModelSelection(input.to)}.`,
    "",
    "Write a complete handoff summary so the next assistant can continue with zero memory loss. Cover:",
    "",
    "1. **Task** — what the user is trying to accomplish, in their own framing.",
    "2. **State** — what is done, what is in progress, what is not started.",
    "3. **Files** — every file read, created, or modified, with paths and what changed in each.",
    "4. **Decisions** — choices made and the reasoning, including approaches tried and rejected.",
    "5. **Environment** — commands run and their outcomes, test/build status, relevant config.",
    "6. **Next steps** — the immediate next action and anything still open or blocked.",
    "7. **Gotchas** — constraints, user preferences, and traps discovered along the way.",
    "",
    "Rules: do NOT call any tools — answer from context only. Do NOT ask questions.",
    "Be specific and concrete: exact paths, identifiers, and commands beat prose.",
    "Respond with the markdown summary and nothing else.",
  ].join("\n");
}

/**
 * Context block prepended to the INCOMING provider's first turn. Wrapped in a
 * tag so the model can tell handed-off state from the user's own message.
 */
export function buildHandoffContextBlock(input: {
  readonly summary: string;
  readonly from: ModelSelection;
  readonly to: ModelSelection;
}): string {
  const from = describeModelSelection(input.from);
  const to = describeModelSelection(input.to);
  return [
    `<handoff-context from="${from}" to="${to}">`,
    "You are taking over an in-progress conversation that was previously handled by",
    `${from}. The summary below is the authoritative record of everything that happened`,
    "before you joined — treat it as your own memory of the conversation. Continue the work",
    "from here; do not restart it or re-introduce yourself. Verify file state before editing",
    "if anything in the summary looks stale.",
    "",
    truncateHandoffSummary(input.summary),
    "</handoff-context>",
  ].join("\n");
}
