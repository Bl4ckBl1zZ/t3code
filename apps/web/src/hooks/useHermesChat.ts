import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { readSidebarWorkspace } from "../sidebarWorkspace";
import { toastManager } from "../components/ui/toast";
import { useServerConfigs, waitForThreadShell } from "../state/entities";
import { hermesEnvironment } from "../state/hermes";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { findReadyHermesEntry } from "../workEnvironmentScope";
import { useHermesConnection } from "./useHermesConnection";
import { useHermesProfile } from "./useHermesProfile";
import { useWorkEnvironment } from "./useWorkEnvironment";

export type StartHermesChatOutcome = "started" | "unavailable" | "failed";
export interface HermesChat {
  readonly isResolved: boolean;
  readonly isReady: boolean;
  readonly start: (options?: { readonly replace?: boolean }) => Promise<StartHermesChatOutcome>;
}

/** Every new Work/Chat entry point opens a native conversation through its environment. */
export function useHermesChat(): HermesChat {
  const environment = useWorkEnvironment();
  const serverConfigs = useServerConfigs();
  const navigate = useNavigate();
  const openConversation = useAtomCommand(hermesEnvironment.workMutate, { reportFailure: true });
  const [connectionId] = useHermesConnection(environment?.environmentId ?? null);
  const provider = environment
    ? findReadyHermesEntry(
        (serverConfigs.get(environment.environmentId)?.providers ?? []).filter(
          (candidate) => !connectionId || candidate.instanceId === connectionId,
        ),
      )
    : null;
  const [profile] = useHermesProfile(
    environment?.environmentId ?? null,
    provider?.instanceId ?? null,
  );
  const isResolved = environment === null || serverConfigs.has(environment.environmentId);
  const isReady = environment !== null && provider !== null;
  const start = useCallback(
    async (options?: { readonly replace?: boolean }): Promise<StartHermesChatOutcome> => {
      if (!environment || !provider) return "unavailable";
      const result = await openConversation({
        environmentId: environment.environmentId,
        input: {
          providerInstanceId: provider.instanceId,
          profile,
          command: {
            type: "conversation.open",
            surface: readSidebarWorkspace() === "chat" ? "chat" : "work",
          },
        },
      });
      if (result._tag === "Failure" || !result.value.threadId) return "failed";
      const threadRef = scopeThreadRef(
        environment.environmentId,
        ThreadId.make(result.value.threadId),
      );
      if (!(await waitForThreadShell(threadRef))) {
        toastManager.add({
          type: "warning",
          title: "Conversation created",
          description:
            "Waiting for it to sync. Open the conversation from the sidebar once it appears.",
        });
        return "failed";
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        ...(options?.replace ? { replace: true } : {}),
      });
      return "started";
    },
    [environment, navigate, openConversation, profile, provider],
  );
  return useMemo(() => ({ isResolved, isReady, start }), [isResolved, isReady, start]);
}
