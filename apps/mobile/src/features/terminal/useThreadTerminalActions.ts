import {
  clearProjectScriptRunPending,
  markProjectScriptRunPending,
  pendingProjectScriptRun,
  projectScriptRunsVersion,
  selectProjectScriptRunState,
  selectRunningProjectScriptTerminal,
  subscribeProjectScriptRuns,
} from "@t3tools/client-runtime/state/terminal";
import type { ProjectScript } from "@t3tools/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { useSelectedThreadProjection } from "../../state/use-thread-detail";
import { useThreadSelection } from "../../state/use-thread-selection";
import { terminalDebugLog } from "./terminalDebugLog";
import {
  buildTerminalMenuSessions,
  nextOpenTerminalId,
  resolveProjectScriptTerminalId,
  type TerminalMenuSession,
} from "./terminalMenu";
import {
  resolvePreferredThreadWorktreePath,
  stagePendingTerminalLaunch,
} from "./terminalLaunchContext";

export interface ThreadTerminalActions {
  readonly knownTerminalSessions: ReturnType<typeof useKnownTerminalSessions>;
  readonly terminalMenuSessions: ReadonlyArray<TerminalMenuSession>;
  /** Ids of single-run project scripts with an active (pending or running) run. */
  readonly activeProjectScriptIds: ReadonlyArray<string>;
  readonly openTerminal: (terminalId?: string | null) => void;
  readonly openNewTerminal: () => void;
  readonly runProjectScript: (script: ProjectScript) => Promise<void>;
}

/**
 * The thread's terminal sessions plus the actions that open them and launch
 * project scripts into them.
 *
 * Lives here rather than in the thread route because more than one surface
 * offers these actions — the header terminal menu and the thread details sheet
 * — and a script launch that staged its terminal differently on one of them
 * would open a shell the other could not find.
 */
export function useThreadTerminalActions(): ThreadTerminalActions {
  const navigation = useNavigation();
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const selectedThreadProjection = useSelectedThreadProjection();
  const threadDetailWorktreePath = selectedThreadProjection?.projection.thread.worktreePath ?? null;
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
  const terminalMenuSessions = useMemo(
    () =>
      buildTerminalMenuSessions({
        knownSessions: knownTerminalSessions,
        workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
      }),
    [knownTerminalSessions, selectedThreadProject?.workspaceRoot],
  );
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const projectScriptRunsStoreVersion = useSyncExternalStore(
    subscribeProjectScriptRuns,
    projectScriptRunsVersion,
    projectScriptRunsVersion,
  );
  const activeProjectScriptIds = useMemo(() => {
    if (!selectedThread) {
      return [];
    }
    const active: string[] = [];
    for (const script of selectedThreadProject?.scripts ?? []) {
      if (!script.singleRun) continue;
      const runState = selectProjectScriptRunState({
        scope: {
          environmentId: selectedThread.environmentId,
          threadId: selectedThread.id,
          scriptId: script.id,
        },
        sessions: knownTerminalSessions,
      });
      if (runState.status !== "idle") {
        active.push(script.id);
      }
    }
    return active;
    // projectScriptRunsStoreVersion invalidates when the shared pending store changes.
  }, [
    knownTerminalSessions,
    selectedThread,
    selectedThreadProject?.scripts,
    projectScriptRunsStoreVersion,
  ]);

  const openTerminal = useCallback(
    (nextTerminalId?: string | null) => {
      terminalDebugLog("terminal-menu:open-existing", {
        terminalId: nextTerminalId ?? null,
        hasThread: Boolean(selectedThread),
        hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      });

      if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
        return;
      }

      void navigation.navigate("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        ...(nextTerminalId ? { terminalId: nextTerminalId } : {}),
      });
    },
    [navigation, selectedThread, selectedThreadProject?.workspaceRoot],
  );

  const openNewTerminal = useCallback(() => {
    terminalDebugLog("terminal-menu:open-new", {
      hasThread: Boolean(selectedThread),
      hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
    });

    if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
      return;
    }

    const nextId = nextOpenTerminalId({
      listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
    });
    void navigation.navigate("ThreadTerminal", {
      environmentId: String(selectedThread.environmentId),
      threadId: String(selectedThread.id),
      terminalId: nextId,
    });
  }, [navigation, selectedThread, selectedThreadProject?.workspaceRoot, terminalMenuSessions]);

  const runProjectScript = useCallback(
    async (script: ProjectScript) => {
      terminalDebugLog("project-script:press", {
        scriptId: script.id,
        command: script.command,
        hasThread: Boolean(selectedThread),
        hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      });

      if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
        terminalDebugLog("project-script:abort", {
          scriptId: script.id,
          reason: "no-thread-or-workspace",
        });
        return;
      }

      const scriptRunScope = {
        environmentId: selectedThread.environmentId,
        threadId: selectedThread.id,
        scriptId: script.id,
      };
      if (script.singleRun) {
        const runningTerminal = selectRunningProjectScriptTerminal(
          knownTerminalSessions,
          script.id,
        );
        const pendingRun = runningTerminal ? null : pendingProjectScriptRun(scriptRunScope);
        const stopTerminalId = runningTerminal?.target.terminalId ?? pendingRun?.terminalId ?? null;
        if (stopTerminalId !== null) {
          // Toggle: interrupt the active (or still-launching) run with Ctrl-C
          // instead of launching again.
          terminalDebugLog("project-script:stop", {
            scriptId: script.id,
            terminalId: stopTerminalId,
          });
          const stopResult = await writeTerminal({
            environmentId: selectedThread.environmentId,
            input: {
              threadId: selectedThread.id,
              terminalId: stopTerminalId,
              data: "\x03",
            },
          });
          if (stopResult._tag !== "Failure" && pendingRun) {
            // The launch was interrupted before the server ever confirmed it;
            // drop the optimistic entry so the control doesn't stay active.
            clearProjectScriptRunPending(scriptRunScope);
          }
          return;
        }
      }

      const targetTerminalId = resolveProjectScriptTerminalId({
        existingTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
        hasRunningTerminal: terminalMenuSessions.some(
          (session) => session.status === "running" || session.status === "starting",
        ),
      });
      const preferredWorktreePath = resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: selectedThread.worktreePath ?? null,
        threadDetailWorktreePath,
      });
      const cwd = projectScriptCwd({
        project: { cwd: selectedThreadProject.workspaceRoot },
        worktreePath: preferredWorktreePath,
      });
      const env = projectScriptRuntimeEnv({
        project: { cwd: selectedThreadProject.workspaceRoot },
        worktreePath: preferredWorktreePath,
      });
      if (script.singleRun) {
        // Optimistically block re-launch until the server confirms the run
        // (or the pending entry expires).
        markProjectScriptRunPending(scriptRunScope, { terminalId: targetTerminalId });
      }
      stagePendingTerminalLaunch({
        target: {
          environmentId: selectedThread.environmentId,
          threadId: selectedThread.id,
          terminalId: targetTerminalId,
        },
        launch: {
          cwd,
          worktreePath: preferredWorktreePath,
          env,
          initialInput: `${script.command}\r`,
          scriptId: script.id,
        },
      });
      terminalDebugLog("project-script:staged", {
        scriptId: script.id,
        terminalId: targetTerminalId,
        cwd,
        worktreePath: preferredWorktreePath,
      });

      void navigation.navigate("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        terminalId: targetTerminalId,
      });
    },
    [
      knownTerminalSessions,
      navigation,
      selectedThread,
      selectedThreadProject,
      terminalMenuSessions,
      threadDetailWorktreePath,
      writeTerminal,
    ],
  );

  return {
    activeProjectScriptIds,
    knownTerminalSessions,
    openNewTerminal,
    openTerminal,
    runProjectScript,
    terminalMenuSessions,
  };
}
