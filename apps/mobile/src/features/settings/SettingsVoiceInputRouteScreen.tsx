import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  DEFAULT_VOICE_INPUT_SETTINGS,
  VOICE_INPUT_MAX_DICTIONARY_ENTRIES,
  type OpenRouterIntegrationStatus,
  type OpenRouterModelOption,
  type VoiceInputSettings,
  type VoiceInputSettingsPatch,
} from "@t3tools/contracts/voice";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  getOpenRouterIntegration,
  getVoiceInputSettings,
  listOpenRouterModels,
  patchVoiceInputSettings,
} from "../voice/mobileVoiceApi";
import { invalidateVoicePreflight } from "../voice/useMobileVoiceInput";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

export function SettingsVoiceInputRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<OpenRouterIntegrationStatus | null>(null);
  const [settings, setSettings] = useState<VoiceInputSettings | null>(null);
  const [audioModels, setAudioModels] = useState<ReadonlyArray<OpenRouterModelOption>>([]);
  const [language, setLanguage] = useState("");
  const [dictionary, setDictionary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const connected = status?.state === "connected";

  // Reload on focus so the model chosen on the picker screen shows up on return.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void Promise.all([getOpenRouterIntegration(), getVoiceInputSettings()])
        .then(([nextStatus, nextSettings]) => {
          if (!active) return;
          setError(null);
          setStatus(nextStatus);
          setSettings(nextSettings);
          setLanguage(nextSettings.language ?? "");
          setDictionary(nextSettings.dictionary.join("\n"));
          if (nextStatus.state !== "connected") {
            setAudioModels([]);
            return;
          }
          void listOpenRouterModels("audio")
            .then((models) => {
              if (active) setAudioModels(models);
            })
            .catch(() => {
              if (active) setAudioModels([]);
            });
        })
        .catch((cause) => {
          if (!active) return;
          setError(cause instanceof Error ? cause.message : "Could not load Voice Input settings.");
        });
      return () => {
        active = false;
      };
    }, []),
  );

  const update = async (patch: VoiceInputSettingsPatch) => {
    try {
      const next = await patchVoiceInputSettings(patch);
      invalidateVoicePreflight();
      setError(null);
      setSettings(next);
      setLanguage(next.language ?? "");
      setDictionary(next.dictionary.join("\n"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The settings request failed.");
    }
  };

  const selectedModel = settings?.model ?? DEFAULT_VOICE_INPUT_SETTINGS.model;
  const selectedModelName =
    audioModels.find((model) => model.id === selectedModel)?.name ?? selectedModel;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Voice Input" onBack={() => navigation.goBack()} />
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
        {error ? <ErrorBanner message={error} /> : null}

        <SettingsSection title="Integration">
          <SettingsRow
            icon="point.3.connected.trianglepath.dotted"
            label="OpenRouter"
            value={connected ? "Connected" : "Connect"}
            target="SettingsOpenRouter"
          />
        </SettingsSection>

        <SettingsSection title="Transcription">
          <SettingsSwitchRow
            icon="wand.and.stars"
            label="Improve transcripts"
            disabled={!connected || !settings}
            value={settings?.cleanup.enabled ?? DEFAULT_VOICE_INPUT_SETTINGS.cleanup.enabled}
            onValueChange={(enabled) => void update({ cleanup: { enabled } })}
          />
          <View className="border-t border-border-subtle">
            <SettingsRow
              disabled={!connected || !settings}
              icon="waveform"
              label="Model"
              value={selectedModelName}
              target="SettingsVoiceModel"
            />
          </View>
        </SettingsSection>

        <SettingsSection title="Spoken language" card>
          <View collapsable={false} className="gap-2 p-4">
            <TextInput
              accessibilityLabel="Spoken language"
              autoCapitalize="none"
              autoCorrect={false}
              editable={connected && settings !== null}
              placeholder="Automatic"
              returnKeyType="done"
              value={language}
              onChangeText={setLanguage}
              onBlur={() => {
                const next = language.trim();
                if (next === (settings?.language ?? "")) return;
                void update({ language: next || null });
              }}
            />
            <Text className="text-xs leading-normal text-foreground-muted">
              Leave empty to detect the language automatically.
            </Text>
          </View>
        </SettingsSection>

        <SettingsSection title="Personal dictionary" card>
          <View collapsable={false} className="gap-2 p-4">
            <TextInput
              accessibilityLabel="Voice Input personal dictionary"
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-32"
              editable={connected && settings !== null}
              multiline
              placeholder="One preferred spelling per line"
              textAlignVertical="top"
              value={dictionary}
              onChangeText={setDictionary}
              onBlur={() => {
                const entries = dictionary
                  .split(/\r?\n/u)
                  .map((entry) => entry.trim())
                  .filter((entry) => entry.length > 0)
                  .slice(0, VOICE_INPUT_MAX_DICTIONARY_ENTRIES);
                if (entries.join("\n") === (settings?.dictionary ?? []).join("\n")) return;
                void update({ dictionary: entries });
              }}
            />
            <Text className="text-xs leading-normal text-foreground-muted">
              Up to {VOICE_INPUT_MAX_DICTIONARY_ENTRIES} entries. Project and chat content are never
              added automatically.
            </Text>
          </View>
        </SettingsSection>

        {!connected ? (
          <Text className="px-2 text-sm leading-normal text-foreground-muted">
            Connect OpenRouter to enable these controls. Saved preferences are preserved.
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
