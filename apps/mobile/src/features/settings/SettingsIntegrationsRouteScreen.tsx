import { useEffect, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { OpenRouterIntegrationStatus } from "@t3tools/contracts/voice";

import { AppText as Text } from "../../components/AppText";
import {
  deleteOpenRouterCredential,
  getOpenRouterIntegration,
  putOpenRouterCredential,
  validateOpenRouterCredential,
} from "../voice/mobileVoiceApi";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";

function label(status: OpenRouterIntegrationStatus | null): string {
  if (!status) return "Checking";
  if (status.state === "connected") return "Connected";
  if (status.state === "validating") return "Validating";
  if (status.state === "invalid") return "Error";
  return status.configured ? "Unavailable" : "Not configured";
}

export function SettingsIntegrationsRouteScreen() {
  const [status, setStatus] = useState<OpenRouterIntegrationStatus | null>(null);
  useEffect(() => {
    void getOpenRouterIntegration()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  return (
    <View className="flex-1 bg-sheet">
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pt-4">
        <SettingsSection title="Integrations">
          <SettingsRow
            icon="point.3.connected.trianglepath.dotted"
            label="OpenRouter"
            value={label(status)}
            target="SettingsOpenRouter"
          />
        </SettingsSection>
      </ScrollView>
    </View>
  );
}

export function SettingsOpenRouterRouteScreen() {
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<OpenRouterIntegrationStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (operation: () => Promise<OpenRouterIntegrationStatus>) => {
    setBusy(true);
    try {
      setStatus(await operation());
      setApiKey("");
    } catch (cause) {
      Alert.alert(
        "OpenRouter unavailable",
        cause instanceof Error ? cause.message : "The OpenRouter request failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void run(getOpenRouterIntegration);
  }, []);

  return (
    <View className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Connection" card>
          <View className="gap-2 p-4">
            <Text className="text-lg text-foreground">{label(status)}</Text>
            <Text className="text-sm text-foreground-muted">
              {status?.credentialHint
                ? `Configured key ${status.credentialHint}. Existing keys are never displayed.`
                : "Connect an account-wide key for Voice Input."}
            </Text>
          </View>
        </SettingsSection>
        <SettingsSection title={status?.configured ? "Replace API key" : "API key"} card>
          <View className="gap-3 p-4">
            <TextInput
              accessibilityLabel="OpenRouter API key"
              autoCapitalize="none"
              autoCorrect={false}
              className="h-12 rounded-xl bg-background px-3 text-base text-foreground"
              placeholder="sk-or-v1-…"
              placeholderTextColor="#888"
              secureTextEntry
              value={apiKey}
              onChangeText={setApiKey}
            />
            <Pressable
              accessibilityRole="button"
              className="items-center rounded-xl bg-accent p-3 disabled:opacity-50"
              disabled={busy || apiKey.trim().length === 0}
              onPress={() => void run(() => putOpenRouterCredential(apiKey))}
            >
              <Text className="font-t3-medium text-accent-foreground">Validate and Connect</Text>
            </Pressable>
          </View>
        </SettingsSection>
        {status?.configured ? (
          <SettingsSection title="Manage" card>
            <View className="gap-2 p-4">
              <Pressable
                accessibilityRole="button"
                className="items-center rounded-xl bg-background p-3"
                disabled={busy}
                onPress={() => void run(validateOpenRouterCredential)}
              >
                <Text className="text-foreground">Revalidate</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                className="items-center rounded-xl bg-destructive/10 p-3"
                disabled={busy}
                onPress={() =>
                  Alert.alert(
                    "Disconnect OpenRouter?",
                    "Voice Input preferences will be preserved.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Disconnect",
                        style: "destructive",
                        onPress: () => void run(deleteOpenRouterCredential),
                      },
                    ],
                  )
                }
              >
                <Text className="text-destructive">Disconnect</Text>
              </Pressable>
            </View>
          </SettingsSection>
        ) : null}
        <Pressable onPress={() => void Linking.openURL("https://openrouter.ai/settings/keys")}>
          <Text className="px-2 text-sm text-accent">Manage keys on OpenRouter</Text>
        </Pressable>
        <Text className="px-2 text-sm text-foreground-muted">
          Audio and transcripts are processed by OpenRouter and the selected upstream providers.
        </Text>
      </ScrollView>
    </View>
  );
}
