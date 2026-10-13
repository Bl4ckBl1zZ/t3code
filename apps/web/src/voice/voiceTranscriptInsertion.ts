import { resolveTranscriptCommit } from "@t3tools/client-runtime/voice-input";

/**
 * The text to insert at `position` in `value` for a transcript: trimmed, with
 * a separating space where English words would otherwise run together.
 * Null when the transcript is blank.
 */
export function voiceTranscriptInsertion(input: {
  readonly value: string;
  readonly position: number;
  readonly transcript: string;
  readonly locale: string;
}): string | null {
  const position = Math.max(0, Math.min(input.position, input.value.length));
  const snapshot = {
    ownerKey: "composer",
    text: input.value,
    selection: { start: position, end: position },
    revision: 0,
  };
  const commit = resolveTranscriptCommit(snapshot, snapshot, input.transcript, input.locale);
  if (commit.kind !== "commit") return null;
  return commit.text.slice(position, commit.text.length - (input.value.length - position));
}
