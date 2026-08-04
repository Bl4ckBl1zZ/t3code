import { assert, describe, it } from "@effect/vitest";

import {
  backgroundOutputTail,
  backgroundTaskIdFromWatchedPath,
  capBackgroundOutput,
  parseBackgroundLaunchAck,
  parseMonitorAck,
  stripTerminalControlSequences,
} from "./backgroundCommand.ts";

// Verbatim tool_result text captured from claude-code 2.1.221. If the CLI ever
// rewords these, the parse must fail loudly here rather than silently stop
// tracking background work.
const LAUNCH_ACK =
  "Command running in background with ID: bs891h9i0. Output is being written to: " +
  "/private/tmp/claude-501/-private-tmp-bgprobe/16b6333e/tasks/bs891h9i0.output. " +
  "You will be notified when it completes. To check interim output, use Read on that file path.";

const MONITOR_ACK =
  "Monitor started (task b8zv6rtg9, timeout 120000ms). You will be notified on each event. " +
  "Keep working — do not poll or sleep.";

describe("parseBackgroundLaunchAck", () => {
  it("reads the task id and output file from a real launch ack", () => {
    const ack = parseBackgroundLaunchAck(LAUNCH_ACK);
    assert.deepStrictEqual(ack, {
      taskId: "bs891h9i0",
      outputPath: "/private/tmp/claude-501/-private-tmp-bgprobe/16b6333e/tasks/bs891h9i0.output",
    });
  });

  it("still reports the handle when no output file is named", () => {
    const ack = parseBackgroundLaunchAck("Command running in background with ID: abc123.");
    assert.deepStrictEqual(ack, { taskId: "abc123", outputPath: null });
  });

  it("ignores ordinary command output", () => {
    assert.strictEqual(parseBackgroundLaunchAck("tick-1\ntick-2"), null);
  });
});

describe("parseMonitorAck", () => {
  it("reads the monitor task and its declared deadline", () => {
    assert.deepStrictEqual(parseMonitorAck(MONITOR_ACK), {
      taskId: "b8zv6rtg9",
      timeoutMs: 120_000,
    });
  });

  it("tolerates a monitor with no stated timeout", () => {
    assert.deepStrictEqual(parseMonitorAck("Monitor started (task zzz)"), {
      taskId: "zzz",
      timeoutMs: null,
    });
  });
});

describe("backgroundTaskIdFromWatchedPath", () => {
  it("links a monitor to the task whose output file it watches", () => {
    const command =
      'until grep -qE "DONE-SENTINEL|FAILED" /private/tmp/claude-501/x/tasks/byggcdigy.output ' +
      "2>/dev/null; do sleep 1; done";
    assert.strictEqual(backgroundTaskIdFromWatchedPath(command), "byggcdigy");
  });

  it("returns null when the monitor watches something else entirely", () => {
    assert.strictEqual(
      backgroundTaskIdFromWatchedPath("until curl -sf localhost:3000; do :; done"),
      null,
    );
  });
});

describe("backgroundOutputTail", () => {
  it("takes the last line that actually says something", () => {
    assert.strictEqual(backgroundOutputTail("step 1\nstep 2\nstep 3\n\n   \n"), "step 3");
  });

  it("collapses a carriage-return progress line to its final frame", () => {
    assert.strictEqual(backgroundOutputTail("building\n 10% \r 50% \r 90% done"), " 90% done");
  });

  it("strips colour codes so the tail is readable text", () => {
    assert.strictEqual(
      backgroundOutputTail("\u001B[32m✓\u001B[0m 14 tests passed"),
      "✓ 14 tests passed",
    );
  });

  it("reports nothing for a command that has printed nothing", () => {
    assert.strictEqual(backgroundOutputTail("\n\n  \n"), null);
  });
});

describe("stripTerminalControlSequences", () => {
  it("removes cursor moves, line erases and window titles", () => {
    assert.strictEqual(
      stripTerminalControlSequences("\u001B[2K\u001B[1Ghello\u001B]0;title\u0007 world"),
      "hello world",
    );
  });
});

describe("capBackgroundOutput", () => {
  it("keeps short output untouched", () => {
    assert.deepStrictEqual(capBackgroundOutput("abc", 10), { output: "abc", truncated: false });
  });

  it("keeps the tail and snaps to a line boundary", () => {
    const result = capBackgroundOutput("aaaa\nbbbb\ncccc\n", 10);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.output, "cccc\n");
  });
});
