/**
 * Pure helpers for commands that outlive the tool call which launched them.
 *
 * Providers give us complementary halves of the problem. Claude hands over a
 * handle without a stream: a task id and an output file, then absolute silence
 * until the task settles (verified against the CLI — no `task_progress` and no
 * `tool_progress` frames arrive for a `local_bash` task, even with partial
 * messages enabled). Codex hands over a stream without a handle: output deltas
 * on a blocking call and no task identity at all.
 *
 * So the live tail has to be read off disk for Claude, and every presentation
 * decision downstream is driven by which of those halves is available.
 */

/** Live tail sent while a command runs. Small on purpose: it ships on a timer. */
export const BACKGROUND_TAIL_LIVE_BYTES = 2_048;

/** Cap for the final output we read back once a command settles. */
export const BACKGROUND_TAIL_FINAL_BYTES = 64_000;

/**
 * Claude's acknowledgement for `Bash` with `run_in_background`. The tool result
 * resolves immediately with this text while the command keeps running, which is
 * precisely why the item must not terminalize here.
 *
 * Shape, verified against claude-code 2.1.221:
 *   "Command running in background with ID: bs891h9i0. Output is being written
 *    to: /…/tasks/bs891h9i0.output. You will be notified when it completes."
 */
const BACKGROUND_LAUNCH_ACK =
  /Command running in background with ID:\s*(?<taskId>[A-Za-z0-9_-]+)\.?(?:[\s\S]*?Output is being written to:\s*(?<outputPath>\S+?)\.?(?:\s|$))?/u;

export interface BackgroundLaunchAck {
  readonly taskId: string;
  readonly outputPath: string | null;
}

export function parseBackgroundLaunchAck(text: string): BackgroundLaunchAck | null {
  const match = BACKGROUND_LAUNCH_ACK.exec(text);
  const taskId = match?.groups?.["taskId"];
  if (taskId === undefined || taskId.length === 0) {
    return null;
  }
  const outputPath = match?.groups?.["outputPath"];
  return {
    taskId,
    outputPath: outputPath === undefined || outputPath.length === 0 ? null : outputPath,
  };
}

/**
 * Claude's `Monitor` acknowledgement, which is the only place the monitor's
 * deadline is stated:
 *   "Monitor started (task b8zv6rtg9, timeout 120000ms)."
 */
const MONITOR_ACK =
  /Monitor started \(task\s+(?<taskId>[A-Za-z0-9_-]+)(?:,\s*timeout\s+(?<timeoutMs>\d+)ms)?/u;

export interface MonitorAck {
  readonly taskId: string;
  readonly timeoutMs: number | null;
}

export function parseMonitorAck(text: string): MonitorAck | null {
  const match = MONITOR_ACK.exec(text);
  const taskId = match?.groups?.["taskId"];
  if (taskId === undefined || taskId.length === 0) {
    return null;
  }
  const timeoutMs = match?.groups?.["timeoutMs"];
  return {
    taskId,
    timeoutMs: timeoutMs === undefined ? null : Number.parseInt(timeoutMs, 10),
  };
}

/**
 * A monitor is a `local_bash` task like any other, so the only link back to
 * what it is watching is the target's output file inside its own command —
 * `until grep -qE "DONE" /…/tasks/byggcdigy.output; do sleep 1; done`. The task
 * id is the file's basename, which makes the link exact rather than a fuzzy
 * match on the command text.
 */
export function backgroundTaskIdFromWatchedPath(command: string): string | null {
  const matches = [...command.matchAll(/([A-Za-z0-9_-]+)\.output\b/gu)];
  const last = matches.at(-1);
  return last?.[1] ?? null;
}

/** CSI, OSC and two-byte escape sequences, plus bare backspace runs. */
const ANSI_ESCAPES = new RegExp(
  [
    "\\u001B\\[[0-9;?]*[ -/]*[@-~]", // CSI: colours, cursor moves, line erase
    "\\u001B\\][^\\u0007]*(?:\\u0007|\\u001B\\\\)", // OSC: window titles, hyperlinks
    "\\u001B[@-Z\\\\-_]", // two-byte escapes
    "\\u0008+", // backspace redraws
  ].join("|"),
  "gu",
);

/**
 * Collapse a carriage-return progress line to what a terminal would actually
 * show. `docker`, `npm` and most test runners redraw one line with `\r`, and
 * without this the tail jitters through half-drawn frames.
 */
function collapseCarriageReturns(line: string): string {
  const segments = line.split("\r");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment !== undefined && segment.trim().length > 0) {
      return segment;
    }
  }
  return "";
}

export function stripTerminalControlSequences(text: string): string {
  return text.replaceAll(ANSI_ESCAPES, "");
}

/**
 * Last line a human would recognise as "what it is doing right now".
 * Returns null when the command has produced nothing yet, which the UI reports
 * honestly instead of implying a hang.
 */
export function backgroundOutputTail(output: string): string | null {
  const lines = stripTerminalControlSequences(output).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = collapseCarriageReturns(lines[index] ?? "").trimEnd();
    if (line.trim().length > 0) {
      return line;
    }
  }
  return null;
}

/**
 * Keep the last `maxBytes` of output, snapped to a line boundary so the tail
 * never opens mid-word. Reports truncation so the UI can say the tail is not
 * the whole story.
 */
export function capBackgroundOutput(
  output: string,
  maxBytes: number,
): { readonly output: string; readonly truncated: boolean } {
  if (output.length <= maxBytes) {
    return { output, truncated: false };
  }
  return { output: dropPartialFirstLine(output.slice(output.length - maxBytes)), truncated: true };
}

/**
 * Drop a leading fragment left by clipping mid-line. Reading a tail by byte
 * offset lands wherever it lands, and one line short beats one line garbled.
 */
export function dropPartialFirstLine(output: string): string {
  const newline = output.indexOf("\n");
  return newline === -1 ? output : output.slice(newline + 1);
}
