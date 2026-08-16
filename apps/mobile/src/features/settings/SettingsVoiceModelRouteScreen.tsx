import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DEFAULT_VOICE_INPUT_SETTINGS, type OpenRouterModelOption } from "@t3tools/contracts/voice";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ErrorBanner } from "../../components/ErrorBanner";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  getVoiceInputSettings,
  listOpenRouterModels,
  patchVoiceInputSettings,
} from "../voice/mobileVoiceApi";
import { invalidateVoicePreflight } from "../voice/useMobileVoiceInput";
import { SettingsActionButton } from "./components/SettingsActionButton";
import { SettingsSection } from "./components/SettingsSection";

/**
 * Dedicated screen for picking the transcription model. The catalog runs to
 * dozens of entries, so it needs a search field and a virtualized list rather
 * than being inlined into the Voice Input screen's ScrollView.
 */
export function SettingsVoiceModelRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const checkmark = useThemeColor("--color-icon");
  const [models, setModels] = useState<ReadonlyArray<OpenRouterModelOption> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([getVoiceInputSettings(), listOpenRouterModels("audio")])
      .then(([settings, audioModels]) => {
        if (!active) return;
        setSelected(settings.model);
        setModels(audioModels);
        if (!audioModels.some((model) => model.id === settings.model))
          setCustomModel(settings.model);
      })
      .catch((cause) => {
        if (!active) return;
        setModels([]);
        setError(cause instanceof Error ? cause.message : "Could not load the model catalog.");
      });
    return () => {
      active = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!models) return [];
    if (!needle) return models;
    return models.filter(
      (model) =>
        model.name.toLowerCase().includes(needle) ||
        model.id.toLowerCase().includes(needle) ||
        model.providerName.toLowerCase().includes(needle),
    );
  }, [models, query]);

  const save = async (model: string) => {
    setSaving(true);
    setError(null);
    try {
      const next = await patchVoiceInputSettings({ model });
      invalidateVoicePreflight();
      setSelected(next.model);
      navigation.goBack();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the model.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Model" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        data={filtered}
        keyExtractor={(model) => model.id}
        ListHeaderComponent={
          <View collapsable={false} className="gap-5">
            {error ? <ErrorBanner message={error} /> : null}
            <TextInput
              accessibilityLabel="Search models"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              placeholder="Search models"
              returnKeyType="search"
              value={query}
              onChangeText={setQuery}
            />
            {models === null ? (
              <View className="items-center py-8">
                <ActivityIndicator />
              </View>
            ) : (
              <Text className="px-2 pb-2 text-sm font-t3-medium text-foreground-muted">
                Audio models
              </Text>
            )}
          </View>
        }
        renderItem={({ item, index }) => {
          const isSelected = item.id === selected;
          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: isSelected, disabled: saving }}
              disabled={saving}
              onPress={() => void save(item.id)}
              className={cn(
                "flex-row items-center gap-4 overflow-hidden bg-card p-4",
                index === 0 ? "rounded-t-[24px]" : "border-t border-border-subtle",
                index === filtered.length - 1 && "rounded-b-[24px]",
              )}
            >
              <View className="min-w-0 flex-1 gap-1">
                <Text className="text-lg text-foreground" numberOfLines={1}>
                  {item.name}
                </Text>
                <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                  {item.available ? item.providerName : `${item.providerName} · Unavailable`}
                </Text>
              </View>
              {isSelected ? (
                <SymbolView
                  name="checkmark"
                  size={18}
                  tintColor={checkmark}
                  type="monochrome"
                  weight="semibold"
                />
              ) : null}
            </Pressable>
          );
        }}
        ListEmptyComponent={
          models === null ? null : (
            <View className="items-center rounded-[24px] bg-card px-6 py-8">
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                {query.trim()
                  ? "No models match that search."
                  : "No audio models are available on this OpenRouter account."}
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          <View collapsable={false} className="gap-5 pt-5">
            <SettingsSection title="Custom model ID" card>
              <View collapsable={false} className="gap-3 p-4">
                <TextInput
                  accessibilityLabel="Custom model ID"
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="provider/model-id"
                  returnKeyType="done"
                  value={customModel}
                  onChangeText={setCustomModel}
                />
                <SettingsActionButton
                  busy={saving}
                  disabled={
                    customModel.trim().length === 0 || customModel.trim() === (selected ?? "")
                  }
                  icon="checkmark"
                  label="Use custom model"
                  tone="primary"
                  onPress={() => void save(customModel.trim())}
                />
              </View>
            </SettingsSection>
            <Text className="px-2 text-sm leading-normal text-foreground-muted">
              Any OpenRouter model that accepts audio input works here. The default is{" "}
              {DEFAULT_VOICE_INPUT_SETTINGS.model}.
            </Text>
          </View>
        }
      />
    </View>
  );
}
