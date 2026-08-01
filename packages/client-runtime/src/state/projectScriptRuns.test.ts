import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type TerminalSummary } from "@t3tools/contracts";

import {
  clearProjectScriptRunPending,
  markProjectScriptRunPending,
  pendingProjectScriptRun,
  PROJECT_SCRIPT_RUN_PENDING_TTL_MS,
  selectProjectScriptRunState,
  selectRunningProjectScriptTerminal,
} from "./projectScriptRuns.ts";
import {
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  type KnownTerminalSession,
} from "./terminalSession.ts";

const scope = (scriptId: string) => ({
  environmentId: "env-1",
  threadId: "thread-1",
  scriptId,
});

function session(input: {
  terminalId: string;
  activeScriptId?: string | null;
  hasRunningSubprocess?: boolean;
}): KnownTerminalSession {
  const summary: TerminalSummary = {
    threadId: "thread-1",
    terminalId: input.terminalId,
    cwd: "/repo",
    worktreePath: null,
    status: "running",
    pid: 4321,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: input.hasRunningSubprocess ?? false,
    activeScriptId: input.activeScriptId ?? null,
    label: "Terminal 1",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    target: {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: input.terminalId,
    },
    state: combineTerminalSessionState(summary, EMPTY_TERMINAL_BUFFER_STATE),
  };
}

describe("project script runs", () => {
  it("attributes a running script to its terminal", () => {
    const sessions = [
      session({ terminalId: "term-1", activeScriptId: "dev-a", hasRunningSubprocess: true }),
      session({ terminalId: "term-2" }),
    ];
    expect(selectRunningProjectScriptTerminal(sessions, "dev-a")?.target.terminalId).toBe("term-1");
    expect(selectRunningProjectScriptTerminal(sessions, "other")).toBeNull();
  });

  it("treats an attributed but idle terminal as not running", () => {
    const sessions = [
      session({ terminalId: "term-1", activeScriptId: "dev-b", hasRunningSubprocess: false }),
    ];
    expect(selectRunningProjectScriptTerminal(sessions, "dev-b")).toBeNull();
    expect(selectProjectScriptRunState({ scope: scope("dev-b"), sessions, nowMs: 0 })).toEqual({
      status: "idle",
      terminalId: null,
    });
  });

  it("marks, expires, and clears pending launches", () => {
    const pendingScope = scope("script-pending");
    markProjectScriptRunPending(pendingScope, { terminalId: "term-3", nowMs: 1_000 });
    expect(pendingProjectScriptRun(pendingScope, 1_000)?.terminalId).toBe("term-3");
    expect(
      selectProjectScriptRunState({ scope: pendingScope, sessions: [], nowMs: 1_000 }),
    ).toEqual({ status: "pending", terminalId: "term-3" });
    expect(
      pendingProjectScriptRun(pendingScope, 1_000 + PROJECT_SCRIPT_RUN_PENDING_TTL_MS + 1),
    ).toBeNull();

    markProjectScriptRunPending(pendingScope, { terminalId: "term-3", nowMs: 1_000 });
    clearProjectScriptRunPending(pendingScope);
    expect(pendingProjectScriptRun(pendingScope, 1_000)).toBeNull();
  });

  it("prefers the server-confirmed run and retires the optimistic entry", () => {
    const runScope = scope("script-run");
    markProjectScriptRunPending(runScope, { terminalId: "term-1", nowMs: 5 });
    const sessions = [
      session({ terminalId: "term-1", activeScriptId: "script-run", hasRunningSubprocess: true }),
    ];
    expect(selectProjectScriptRunState({ scope: runScope, sessions, nowMs: 5 })).toEqual({
      status: "running",
      terminalId: "term-1",
    });
    // Once confirmed, the pending entry must not resurface after the run ends.
    expect(selectProjectScriptRunState({ scope: runScope, sessions: [], nowMs: 5 })).toEqual({
      status: "idle",
      terminalId: null,
    });
  });
});
