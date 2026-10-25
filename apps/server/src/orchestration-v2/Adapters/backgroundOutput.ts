/**
 * Live output for work that outlives its turn: a background Bash task, a Codex
 * command left running. Adapters keep only what is needed to answer "what is it
 * doing right now" and read it on demand, so a chatty dev server costs nothing
 * while no client is looking.
 */
import { ORCHESTRATION_V2_BACKGROUND_OUTPUT_LINE_MAX_LENGTH } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

/** Bytes kept or read per task: enough to find the last line of a noisy command. */
const BACKGROUND_OUTPUT_TAIL_BYTES = 2_048;

/** CSI, OSC and two-byte escape sequences, plus backspace runs. */
const TERMINAL_CONTROL_SEQUENCES = new RegExp(
  [
    "\\u001B\\[[0-9;?]*[ -/]*[@-~]",
    "\\u001B\\][^\\u0007]*(?:\\u0007|\\u001B\\\\)",
    "\\u001B[@-Z\\\\-_]",
    "\\u0008+",
  ].join("|"),
  "gu",
);

/**
 * The last line a reader would recognise as "what it is doing now". Progress
 * bars redraw one line with `\r`, so only the last drawn segment counts.
 * Null when nothing has been printed yet.
 */
export function lastBackgroundOutputLine(output: string): string | null {
  const lines = output.replaceAll(TERMINAL_CONTROL_SEQUENCES, "").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const segments = (lines[index] ?? "").split("\r");
    for (let segment = segments.length - 1; segment >= 0; segment -= 1) {
      const line = (segments[segment] ?? "").trim();
      if (line.length > 0) {
        return line.length > ORCHESTRATION_V2_BACKGROUND_OUTPUT_LINE_MAX_LENGTH
          ? `${line.slice(0, ORCHESTRATION_V2_BACKGROUND_OUTPUT_LINE_MAX_LENGTH - 1)}…`
          : line;
      }
    }
  }
  return null;
}

/** Appends streamed output, keeping only the newest `maxLength` characters. */
export function appendBackgroundOutputTail(
  tail: string,
  delta: string,
  maxLength = BACKGROUND_OUTPUT_TAIL_BYTES,
): string {
  const combined = `${tail}${delta}`;
  return combined.length <= maxLength ? combined : combined.slice(-maxLength);
}

/**
 * Claude's `run_in_background` acknowledgement prose is the only place the output file is
 * named. The path must be the task's own `<id>.output`, so command output that merely
 * looks like an acknowledgement cannot point the tail at an arbitrary file.
 */
const CLAUDE_BACKGROUND_LAUNCH =
  /Command running in background with ID:\s*(?<taskId>[A-Za-z0-9_-]+)\.?[\s\S]*?Output is being written to:\s*(?<outputPath>\S+?)\.?(?:\s|$)/u;

export function parseClaudeBackgroundLaunch(
  text: string,
): { readonly taskId: string; readonly outputPath: string } | null {
  const match = CLAUDE_BACKGROUND_LAUNCH.exec(text);
  const taskId = match?.groups?.["taskId"];
  const outputPath = match?.groups?.["outputPath"];
  if (taskId === undefined || outputPath === undefined) return null;
  const fileName = outputPath.split(/[\\/]/u).at(-1);
  return fileName === `${taskId}.output` ? { taskId, outputPath } : null;
}

/**
 * The last line of a file another process is writing, and when it last
 * changed. Reads at most `BACKGROUND_OUTPUT_TAIL_BYTES` from the end. Null when
 * the file is missing or unreadable: a poll must never fail the stream.
 */
export const readBackgroundOutputFile = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: string;
}): Effect.Effect<{
  readonly lastLine: string | null;
  readonly lastOutputAt: DateTime.Utc | null;
} | null> =>
  Effect.scoped(
    Effect.gen(function* () {
      const file = yield* input.fileSystem.open(input.path, { flag: "r" });
      const info = yield* file.stat;
      const size = Number(info.size);
      const lastOutputAt = Option.match(info.mtime, {
        onNone: () => null,
        onSome: (mtime) => DateTime.fromDateUnsafe(mtime),
      });
      if (size === 0) return { lastLine: null, lastOutputAt: null };
      if (size > BACKGROUND_OUTPUT_TAIL_BYTES) {
        yield* file.seek(BigInt(size - BACKGROUND_OUTPUT_TAIL_BYTES), "start");
      }
      const bytes = yield* file.readAlloc(Math.min(size, BACKGROUND_OUTPUT_TAIL_BYTES));
      const text = new TextDecoder().decode(Option.getOrElse(bytes, () => new Uint8Array()));
      return { lastLine: lastBackgroundOutputLine(text), lastOutputAt };
    }),
  ).pipe(Effect.orElseSucceed(() => null));
