import { describe, expect, it } from "vite-plus/test";

import {
  appendBackgroundOutputTail,
  lastBackgroundOutputLine,
  parseClaudeBackgroundLaunch,
} from "./backgroundOutput.ts";

describe("lastBackgroundOutputLine", () => {
  it("shows what a terminal would show last", () => {
    expect(lastBackgroundOutputLine("\u001b[1mbuild\u001b[0m\n 40%\r 90%\r\n\n")).toBe("90%");
    expect(lastBackgroundOutputLine("\n  \n")).toBeNull();
  });

  it("caps a long line", () => {
    expect(lastBackgroundOutputLine("x".repeat(1_000))?.length).toBe(240);
  });
});

describe("appendBackgroundOutputTail", () => {
  it("keeps only the newest output", () => {
    expect(appendBackgroundOutputTail("abc", "def", 4)).toBe("cdef");
  });
});

describe("parseClaudeBackgroundLaunch", () => {
  it("reads the task's output file from the acknowledgement", () => {
    expect(
      parseClaudeBackgroundLaunch(
        "Command running in background with ID: bs891h9i0. Output is being written to: /tmp/claude/tasks/bs891h9i0.output. You will be notified when it completes.",
      ),
    ).toEqual({ taskId: "bs891h9i0", outputPath: "/tmp/claude/tasks/bs891h9i0.output" });
  });

  it("refuses a path that is not the task's own output file", () => {
    expect(
      parseClaudeBackgroundLaunch(
        "Command running in background with ID: bs891h9i0. Output is being written to: /etc/passwd.",
      ),
    ).toBeNull();
  });
});
