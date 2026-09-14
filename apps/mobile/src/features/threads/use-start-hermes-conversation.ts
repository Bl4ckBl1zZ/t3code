import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useRef } from "react";
import { Alert } from "react-native";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveHermesConversationTarget } from "../../lib/mobileWorkspace";
import { environmentServerConfigsAtom } from "../../state/server";
import { hermesEnvironment } from "../../state/hermes";
import { useAtomCommand } from "../../state/use-atom-command";

/** Starts a Hermes-owned session without creating a client-side project draft. */
export function useStartHermesConversation(input?: {
  readonly requiredEnvironmentId?: EnvironmentId | null;
  readonly sourceThreadId?: string;
  readonly providerInstanceId?: string;
}) {
  const navigation = useNavigation();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const requiredEnvironmentId = input?.requiredEnvironmentId ?? null;
  const sourceThreadId = input?.sourceThreadId;
  const requiredProviderInstanceId = input?.providerInstanceId;
  const mutate = useAtomCommand(hermesEnvironment.workMutate, { label: "Start Work conversation" });
  const busy = useRef(false);
  return useCallback(() => {
    if (busy.current) return;
    const target = resolveHermesConversationTarget({
      serverConfigs,
      requiredEnvironmentId,
      ...(requiredProviderInstanceId ? { requiredProviderInstanceId } : {}),
    });
    if (!target) {
      Alert.alert(
        "Hermes is not ready",
        "Set up Hermes and connect a model before starting a Work conversation.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Set up Hermes",
            onPress: () =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsHermesWork" },
              }),
          },
        ],
      );
      return;
    }
    busy.current = true;
    void mutate({
      environmentId: target.environmentId,
      input: {
        providerInstanceId: target.providerInstanceId,
        profile: "default",
        command: { type: "conversation.open", ...(sourceThreadId ? { sourceThreadId } : {}) },
      },
    })
      .then((result) => {
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            Alert.alert(
              "Could not start Work",
              error instanceof Error ? error.message : String(error),
            );
          }
        } else if (result.value.threadId) {
          navigation.navigate("Thread", {
            environmentId: target.environmentId,
            threadId: ThreadId.make(result.value.threadId),
          });
        } else {
          Alert.alert(
            "Could not open conversation",
            "Hermes did not return a conversation reference.",
          );
        }
      })
      .finally(() => {
        busy.current = false;
      });
  }, [
    mutate,
    navigation,
    requiredEnvironmentId,
    serverConfigs,
    sourceThreadId,
    requiredProviderInstanceId,
  ]);
}
