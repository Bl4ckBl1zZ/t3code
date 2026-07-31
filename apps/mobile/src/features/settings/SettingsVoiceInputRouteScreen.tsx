import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  DEFAULT_VOICE_INPUT_SETTINGS,
  type OpenRouterIntegrationStatus,
  type VoiceInputSettings,
  type VoiceInputSettingsPatch,
} from "@t3tools/contracts/voice";

import { AppText as Text } from "../../components/AppText";
import {
  getOpenRouterIntegration,
  getVoiceInputSettings,
  patchVoiceInputSettings,
} from "../voice/mobileVoiceApi";
import { invalidateVoicePreflight } from "../voice/useMobileVoiceInput";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

export function SettingsVoiceInputRouteScreen() {
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<OpenRouterIntegrationStatus | null>(null);
  const [settings, setSettings] = useState<VoiceInputSettings | null>(null);
  const [dictionary, setDictionary] = useState("");
  const connected = status?.state === "connected";

  useEffect(() => {
    void Promise.all([getOpenRouterIntegration(), getVoiceInputSettings()])
      .then(([nextStatus, nextSettings]) => {
        setStatus(nextStatus);
        setSettings(nextSettings);
        setDictionary(nextSettings.dictionary.join("\n"));
      })
      .catch((cause) =>
        Alert.alert(
          "Voice Input unavailable",
          cause instanceof Error ? cause.message : "Could not load Voice Input settings.",
        ),
      );
  }, []);

  const update = async (patch: VoiceInputSettingsPatch) => {
    try {
      const next = await patchVoiceInputSettings(patch);
      invalidateVoicePreflight();
      setSettings(next);
      setDictionary(next.dictionary.join("\n"));
    } catch (cause) {
      Alert.alert(
        "Could not save Voice Input",
        cause instanceof Error ? cause.message : "The settings request failed.",
      );
    }
  };

  return (
    <View className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Integration">
          <SettingsRow
            icon="point.3.connected.trianglepath.dotted"
            label="OpenRouter"
            value={connected ? "Connected" : "Connect"}
            target="SettingsOpenRouter"
          />
        </SettingsSection>
        <SettingsSection title="Behavior">
          <SettingsSwitchRow
            icon="wand.and.stars"
            label="Improve transcripts"
            disabled={!connected || !settings}
            value={settings?.cleanup.enabled ?? DEFAULT_VOICE_INPUT_SETTINGS.cleanup.enabled}
            onValueChange={(enabled) => void update({ cleanup: { enabled } })}
          />
        </SettingsSection>
        <SettingsSection title="Models and language" card>
          <View className={!connected ? "gap-4 p-4 opacity-45" : "gap-4 p-4"}>
            <Text className="text-sm text-foreground-muted">Transcription model</Text>
            <TextInput
              accessibilityLabel="Voice transcription model"
              editable={connected}
              className="h-11 rounded-xl bg-background px-3 text-foreground"
              autoCapitalize="none"
              value={
                settings?.transcriptionModel ?? DEFAULT_VOICE_INPUT_SETTINGS.transcriptionModel
              }
              onEndEditing={(event) =>
                void update({ transcriptionModel: event.nativeEvent.text.trim() })
              }
            />
            <Text className="text-sm text-foreground-muted">Cleanup model</Text>
            <TextInput
              accessibilityLabel="Transcript cleanup model"
              editable={connected && settings?.cleanup.enabled !== false}
              className="h-11 rounded-xl bg-background px-3 text-foreground"
              autoCapitalize="none"
              value={settings?.cleanup.model ?? DEFAULT_VOICE_INPUT_SETTINGS.cleanup.model}
              onEndEditing={(event) =>
                void update({ cleanup: { model: event.nativeEvent.text.trim() } })
              }
            />
            <Text className="text-sm text-foreground-muted">Spoken language</Text>
            <TextInput
              accessibilityLabel="Spoken language"
              editable={connected}
              className="h-11 rounded-xl bg-background px-3 text-foreground"
              autoCapitalize="none"
              placeholder="Automatic"
              value={settings?.language ?? ""}
              onEndEditing={(event) => {
                const language = event.nativeEvent.text.trim();
                void update({ language: language || null });
              }}
            />
          </View>
        </SettingsSection>
        <SettingsSection title="Personal dictionary" card>
          <View className="gap-2 p-4">
            <TextInput
              accessibilityLabel="Voice Input personal dictionary"
              editable={connected}
              multiline
              className="min-h-32 rounded-xl bg-background p-3 text-foreground"
              placeholder="One preferred spelling per line"
              textAlignVertical="top"
              value={dictionary}
              onChangeText={setDictionary}
              onEndEditing={() => void update({ dictionary: dictionary.split(/\r?\n/u) })}
            />
            <Text className="text-xs text-foreground-muted">
              Up to 250 entries. Project and chat content are never added automatically.
            </Text>
          </View>
        </SettingsSection>
        {!connected ? (
          <Pressable accessibilityRole="button">
            <Text className="px-2 text-sm text-foreground-muted">
              Connect OpenRouter to enable model-dependent controls. Saved preferences are
              preserved.
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}
