import { useMemo } from "react";
import type { ProviderDriverKind } from "@t3tools/contracts";

import {
  isThreadVisibleInSidebarWorkspace,
  sidebarProviderInstanceKey,
} from "../components/Sidebar.logic";
import { useSidebarWorkspace } from "../sidebarWorkspace";
import { useServerConfigs, useThreadShells } from "../state/entities";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import {
  resolveWorkEnvironmentScope,
  useWorkEnvironmentScopePreference,
} from "../workEnvironmentScope";

/** Management uses the same environment resolution as the preserved Work/Chat switcher. */
export function useWorkEnvironment() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverConfigs = useServerConfigs();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const [workspace] = useSidebarWorkspace();
  const [storedEnvironmentId] = useWorkEnvironmentScopePreference();
  const environmentId = useMemo(() => {
    const providerKinds = new Map<string, ProviderDriverKind>();
    for (const [environmentId, config] of serverConfigs) {
      for (const provider of config.providers)
        providerKinds.set(
          sidebarProviderInstanceKey(environmentId, provider.instanceId),
          provider.driver,
        );
    }
    const threadEnvironmentIds = new Set(
      threads
        .filter((thread) =>
          isThreadVisibleInSidebarWorkspace(
            thread,
            workspace === "chat" ? "chat" : "work",
            providerKinds,
          ),
        )
        .map((thread) => thread.environmentId),
    );
    return (
      resolveWorkEnvironmentScope({
        environments,
        serverConfigs,
        threadEnvironmentIds,
        storedEnvironmentId,
        primaryEnvironmentId,
      }).scopeId ?? primaryEnvironmentId
    );
  }, [environments, primaryEnvironmentId, serverConfigs, storedEnvironmentId, threads, workspace]);
  return useEnvironment(environmentId);
}
