import {
  projectScriptRunsVersion,
  selectProjectScriptRunState,
  subscribeProjectScriptRuns,
  type KnownTerminalSession,
  type ProjectScriptRunState,
} from "@t3tools/client-runtime/state/terminal";
import type { EnvironmentId, ProjectScript, ThreadId } from "@t3tools/contracts";
import { useMemo, useSyncExternalStore } from "react";

const NO_RUN_STATES: ReadonlyMap<string, ProjectScriptRunState> = new Map();

/**
 * Run state per single-run project script (scripts without `singleRun` are
 * omitted — they may run concurrently, so per-script state is meaningless).
 */
export function useProjectScriptRunStates(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly scripts: ReadonlyArray<ProjectScript> | undefined;
  readonly sessions: ReadonlyArray<KnownTerminalSession>;
}): ReadonlyMap<string, ProjectScriptRunState> {
  const pendingVersion = useSyncExternalStore(
    subscribeProjectScriptRuns,
    projectScriptRunsVersion,
    projectScriptRunsVersion,
  );
  return useMemo(() => {
    if (input.environmentId === null || input.threadId === null || !input.scripts) {
      return NO_RUN_STATES;
    }
    const singleRunScripts = input.scripts.filter((script) => script.singleRun);
    if (singleRunScripts.length === 0) {
      return NO_RUN_STATES;
    }
    const states = new Map<string, ProjectScriptRunState>();
    for (const script of singleRunScripts) {
      const state = selectProjectScriptRunState({
        scope: {
          environmentId: input.environmentId,
          threadId: input.threadId,
          scriptId: script.id,
        },
        sessions: input.sessions,
      });
      if (state.status !== "idle") {
        states.set(script.id, state);
      }
    }
    return states.size > 0 ? states : NO_RUN_STATES;
    // pendingVersion invalidates the memo when the shared pending store changes.
  }, [input.environmentId, input.threadId, input.scripts, input.sessions, pendingVersion]);
}
