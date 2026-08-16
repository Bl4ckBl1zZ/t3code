import { Link } from "@tanstack/react-router";
import {
  DEFAULT_VOICE_INPUT_SETTINGS,
  type OpenRouterIntegrationStatus,
  type OpenRouterModelOption,
  type VoiceInputSettings,
  type VoiceInputSettingsPatch,
} from "@t3tools/contracts/voice";
import { useCallback, useEffect, useState } from "react";

import {
  getOpenRouterIntegration,
  getVoiceInputSettings,
  listOpenRouterModels,
  patchVoiceInputSettings,
} from "../../cloud/voiceInput";
import { invalidateVoicePreflight } from "../../voice/useWebVoiceInput";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { VoiceModelPicker } from "./VoiceModelPicker";

export function VoiceInputSettingsSection() {
  const [status, setStatus] = useState<OpenRouterIntegrationStatus | null>(null);
  const [settings, setSettings] = useState<VoiceInputSettings | null>(null);
  const [audioModels, setAudioModels] = useState<ReadonlyArray<OpenRouterModelOption>>([]);
  const [customModel, setCustomModel] = useState(false);
  const [customModelDraft, setCustomModelDraft] = useState("");
  const [dictionaryDraft, setDictionaryDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const connected = status?.state === "connected";

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextStatus, nextSettings] = await Promise.all([
        getOpenRouterIntegration(),
        getVoiceInputSettings(),
      ]);
      setStatus(nextStatus);
      setSettings(nextSettings);
      setDictionaryDraft(nextSettings.dictionary.join("\n"));
      if (nextStatus.state === "connected") {
        const nextAudioModels = await listOpenRouterModels("audio");
        setAudioModels(nextAudioModels);
        setCustomModel(!nextAudioModels.some((model) => model.id === nextSettings.model));
        setCustomModelDraft(nextSettings.model);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Voice Input settings.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback(
    async (patch: VoiceInputSettingsPatch) => {
      if (!settings) return;
      setError(null);
      try {
        const next = await patchVoiceInputSettings(patch);
        invalidateVoicePreflight();
        setSettings(next);
        setDictionaryDraft(next.dictionary.join("\n"));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not save Voice Input settings.");
      }
    },
    [settings],
  );

  return (
    <SettingsSection title="Voice Input">
      <SettingsRow
        title="OpenRouter"
        description={
          connected
            ? "Connected account integration. Audio and transcripts are processed by OpenRouter and the selected upstream providers."
            : "Connect OpenRouter to enable transcription and transcript cleanup."
        }
        status={error ?? (status === null ? "Checking connection…" : undefined)}
        control={
          <Button
            size="sm"
            variant={connected ? "outline" : "default"}
            render={<Link to="/settings/integrations/openrouter" />}
          >
            {connected ? "Manage integration" : "Connect OpenRouter"}
          </Button>
        }
      />
      <SettingsRow
        title="Improve transcripts"
        description="Conservatively fix punctuation, casing, spacing, and obvious transcription errors."
        control={
          <Switch
            aria-label="Improve voice transcripts"
            checked={settings?.cleanup.enabled ?? DEFAULT_VOICE_INPUT_SETTINGS.cleanup.enabled}
            disabled={!connected || settings === null}
            onCheckedChange={(enabled) => void update({ cleanup: { enabled } })}
          />
        }
      />
      <SettingsRow
        title="Voice model"
        description="A single OpenRouter model that understands audio transcribes and improves your dictation. Only audio-capable models are listed."
        control={
          <div className="flex w-full flex-col gap-2 sm:w-72">
            <VoiceModelPicker
              models={audioModels}
              value={settings?.model ?? ""}
              isCustom={customModel}
              disabled={!connected || settings === null}
              onSelect={(modelId) => {
                setCustomModel(false);
                void update({ model: modelId });
              }}
              onSelectCustom={() => {
                setCustomModel(true);
                setCustomModelDraft(settings?.model ?? "");
              }}
            />
            {customModel ? (
              <input
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
                aria-label="Custom voice model ID"
                disabled={!connected || settings === null}
                placeholder="provider/model-id"
                value={customModelDraft}
                onChange={(event) => setCustomModelDraft(event.currentTarget.value)}
                onBlur={() => {
                  const value = customModelDraft.trim();
                  if (value && value !== settings?.model) void update({ model: value });
                }}
              />
            ) : null}
          </div>
        }
      />
      <SettingsRow
        title="Spoken language"
        description="Leave automatic detection enabled, or provide an ISO language code such as en or de."
        control={
          <input
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm sm:w-40"
            aria-label="Spoken language"
            disabled={!connected || settings === null}
            placeholder="Automatic"
            value={settings?.language ?? ""}
            onChange={(event) => {
              const value = event.currentTarget.value.trim();
              void update({ language: value || null });
            }}
          />
        }
      />
      <SettingsRow
        title="Personal dictionary"
        description="One preferred spelling per line. Up to 250 entries; project and chat content are never added automatically."
      >
        <div className="pt-3">
          <textarea
            className="min-h-28 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm"
            aria-label="Voice Input personal dictionary"
            disabled={!connected || settings === null}
            value={dictionaryDraft}
            onChange={(event) => setDictionaryDraft(event.currentTarget.value)}
            onBlur={() =>
              void update({
                dictionary: dictionaryDraft.split(/\r?\n/u),
              })
            }
          />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
