import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Alert } from "react-native";

import type { EnvironmentId } from "@t3tools/contracts";

import { resolveHermesConversationTarget } from "../../lib/mobileWorkspace";
import { environmentServerConfigsAtom } from "../../state/server";
import { useProjects } from "../../state/entities";

/**
 * Opens a fresh-context T3 Work conversation on the Hermes backing project.
 *
 * Shared by the home "start task" affordance and the composer's /new and
 * /reset commands so both resolve the same target and surface the same
 * not-ready message.
 */
export function useStartHermesConversation(input?: {
  readonly requiredEnvironmentId?: EnvironmentId | null;
}) {
  const navigation = useNavigation();
  const projects = useProjects();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const requiredEnvironmentId = input?.requiredEnvironmentId ?? null;

  return useCallback(() => {
    const target = resolveHermesConversationTarget({
      projects,
      serverConfigs,
      requiredEnvironmentId,
    });
    if (!target) {
      Alert.alert(
        "Hermes is not ready",
        "Enable and configure Hermes on a connected environment before starting a Work conversation.",
      );
      return;
    }
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        environmentId: String(target.project.environmentId),
        projectId: String(target.project.id),
        title: "Hermes",
        workspace: "work",
        providerInstanceId: String(target.modelSelection.instanceId),
        model: target.modelSelection.model,
      },
    });
  }, [navigation, projects, requiredEnvironmentId, serverConfigs]);
}
