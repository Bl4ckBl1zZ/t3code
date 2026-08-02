import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  DEFAULT_VOICE_INPUT_SETTINGS,
  type OpenRouterIntegrationStatus,
  type OpenRouterModelOption,
  type VoiceInputSettings,
  type VoiceInputSettingsPatch,
} from "@t3tools/contracts/voice";

import { AppText as Text } from "../../components/AppText";
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
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<OpenRouterIntegrationStatus | null>(null);
  const [settings, setSettings] = useState<VoiceInputSettings | null>(null);
  const [audioModels, setAudioModels] = useState<ReadonlyArray<OpenRouterModelOption>>([]);
  const [dictionary, setDictionary] = useState("");
  const connected = status?.state === "connected";

  useEffect(() => {
    void Promise.all([getOpenRouterIntegration(), getVoiceInputSettings()])
      .then(([nextStatus, nextSettings]) => {
        setStatus(nextStatus);
        setSettings(nextSettings);
        setDictionary(nextSettings.dictionary.join("\n"));
        if (nextStatus.state === "connected") {
          void listOpenRouterModels("audio")
            .then(setAudioModels)
            .catch(() => setAudioModels([]));
        }
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
        <SettingsSection title="Model and language" card>
          <View className={!connected ? "gap-4 p-4 opacity-45" : "gap-4 p-4"}>
            <Text className="text-sm text-foreground-muted">Voice model</Text>
            {audioModels.length > 0 ? (
              <View className="gap-1">
                {audioModels.map((model) => {
                  const selected = settings?.model === model.id;
                  return (
                    <Pressable
                      key={model.id}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      disabled={!connected}
                      className={
                        selected
                          ? "flex-row items-center justify-between rounded-xl bg-background px-3 py-2.5"
                          : "flex-row items-center justify-between rounded-xl px-3 py-2.5"
                      }
                      onPress={() => void update({ model: model.id })}
                    >
                      <Text className="flex-1 pr-2 text-foreground" numberOfLines={1}>
                        {model.name}
                      </Text>
                      {selected ? <Text className="text-foreground">✓</Text> : null}
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
            <Text className="text-sm text-foreground-muted">Custom model ID</Text>
            <TextInput
              accessibilityLabel="Voice model"
              editable={connected}
              className="h-11 rounded-xl bg-background px-3 text-foreground"
              autoCapitalize="none"
              placeholder="provider/model-id"
              key={settings?.model ?? "default"}
              defaultValue={settings?.model ?? DEFAULT_VOICE_INPUT_SETTINGS.model}
              onEndEditing={(event) => {
                const model = event.nativeEvent.text.trim();
                if (model) void update({ model });
              }}
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
          <Text className="px-2 text-sm text-foreground-muted">
            Connect OpenRouter to enable model-dependent controls. Saved preferences are preserved.
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
