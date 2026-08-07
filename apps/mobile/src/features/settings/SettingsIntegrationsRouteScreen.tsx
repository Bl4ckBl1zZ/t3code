import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { OpenRouterIntegrationStatus } from "@t3tools/contracts/voice";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  deleteOpenRouterCredential,
  getOpenRouterIntegration,
  putOpenRouterCredential,
  validateOpenRouterCredential,
} from "../voice/mobileVoiceApi";
import { invalidateVoicePreflight } from "../voice/useMobileVoiceInput";
import { SettingsActionButton } from "./components/SettingsActionButton";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";

function label(status: OpenRouterIntegrationStatus | null, loaded: boolean): string {
  if (!loaded) return "Checking";
  // A settled-but-absent status means the status request itself failed.
  if (!status) return "Unavailable";
  if (status.state === "connected") return "Connected";
  if (status.state === "validating") return "Validating";
  if (status.state === "invalid") return "Error";
  return status.configured ? "Unavailable" : "Not configured";
}

function formatValidatedAt(isoDate: string | undefined): string | null {
  if (!isoDate) return null;
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString();
}

export function SettingsIntegrationsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<OpenRouterIntegrationStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void getOpenRouterIntegration()
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoaded(true));
  }, []);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Integrations" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Integrations">
          <SettingsRow
            icon="point.3.connected.trianglepath.dotted"
            label="OpenRouter"
            value={label(status, loaded)}
            target="SettingsOpenRouter"
          />
        </SettingsSection>
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          OpenRouter powers Voice Input transcription.
        </Text>
      </ScrollView>
    </View>
  );
}

export function SettingsOpenRouterRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<OpenRouterIntegrationStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (operation: () => Promise<OpenRouterIntegrationStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await operation());
      invalidateVoicePreflight();
      setApiKey("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The OpenRouter request failed.");
    } finally {
      setLoaded(true);
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run(getOpenRouterIntegration);
  }, [run]);

  const validatedAt = formatValidatedAt(status?.lastValidatedAt);
  const confirmDisconnect = () =>
    Alert.alert("Disconnect OpenRouter?", "Voice Input preferences will be preserved.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: () => void run(deleteOpenRouterCredential),
      },
    ]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="OpenRouter" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Connection" card>
          <View collapsable={false} className="gap-1.5 p-4">
            <Text className="text-lg text-foreground">{label(status, loaded)}</Text>
            <Text className="text-sm leading-normal text-foreground-muted">
              {status?.credentialHint
                ? `Configured key ${status.credentialHint}. Existing keys are never displayed.`
                : "Connect an account-wide key for Voice Input."}
            </Text>
            {validatedAt ? (
              <Text className="text-sm leading-normal text-foreground-muted">
                Last validated {validatedAt}.
              </Text>
            ) : null}
          </View>
        </SettingsSection>

        <SettingsSection title={status?.configured ? "Replace API key" : "API key"} card>
          <View collapsable={false} className="gap-3 p-4">
            <TextInput
              accessibilityLabel="OpenRouter API key"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              placeholder="sk-or-v1-…"
              secureTextEntry
              textContentType="password"
              value={apiKey}
              onChangeText={setApiKey}
              onSubmitEditing={() => {
                if (apiKey.trim().length > 0) void run(() => putOpenRouterCredential(apiKey));
              }}
            />
            {error ? <ErrorBanner message={error} /> : null}
            <SettingsActionButton
              busy={busy}
              disabled={apiKey.trim().length === 0}
              icon="key"
              label="Validate and connect"
              tone="primary"
              onPress={() => void run(() => putOpenRouterCredential(apiKey))}
            />
          </View>
        </SettingsSection>

        {status?.configured ? (
          <SettingsSection title="Manage" card>
            <View collapsable={false} className="gap-3 p-4">
              <SettingsActionButton
                disabled={busy}
                icon="arrow.clockwise"
                label="Revalidate"
                onPress={() => void run(validateOpenRouterCredential)}
              />
              <SettingsActionButton
                disabled={busy}
                icon="trash"
                label="Disconnect"
                tone="danger"
                onPress={confirmDisconnect}
              />
            </View>
          </SettingsSection>
        ) : null}

        <SettingsActionButton
          icon="arrow.up.right"
          label="Manage keys on OpenRouter"
          onPress={() => void Linking.openURL("https://openrouter.ai/settings/keys")}
        />

        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Audio and transcripts are processed by OpenRouter and the selected upstream providers.
        </Text>
      </ScrollView>
    </View>
  );
}
