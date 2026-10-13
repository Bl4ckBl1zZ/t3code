import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  VOICE_INPUT_MAX_DICTIONARY_ENTRIES,
  VOICE_INPUT_MAX_DICTIONARY_ENTRY_LENGTH,
  type VoiceInputSettingsPatch,
} from "@t3tools/contracts/relay";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  updateManagedRelayVoiceInputSettingsCommand,
  useManagedRelayVoiceInput,
} from "../../cloud/managedRelayState";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const AUTOMATIC_LANGUAGE = "auto";

/** Spoken-language hints offered in the picker. The model handles others on automatic. */
const VOICE_LANGUAGES: ReadonlyArray<{ readonly code: string; readonly label: string }> = [
  { code: "en", label: "English" },
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "sv", label: "Swedish" },
  { code: "tr", label: "Turkish" },
  { code: "uk", label: "Ukrainian" },
  { code: "ru", label: "Russian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
  { code: "hi", label: "Hindi" },
];

function languageLabel(code: string | null): string {
  if (code === null) return "Automatic";
  return VOICE_LANGUAGES.find((language) => language.code === code)?.label ?? code;
}

/** One entry per line, trimmed, without blanks or repeats. */
function parseVoiceDictionary(text: string): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const line of text.split("\n")) {
    const entry = line.trim().slice(0, VOICE_INPUT_MAX_DICTIONARY_ENTRY_LENGTH);
    const key = entry.toLocaleLowerCase();
    if (!entry || seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length === VOICE_INPUT_MAX_DICTIONARY_ENTRIES) break;
  }
  return entries;
}

function formatMinutes(seconds: number): string {
  const minutes = seconds / 60;
  return Number.isInteger(minutes) ? `${minutes}` : minutes.toFixed(1);
}

function VoiceInputUnavailable(props: {
  readonly message: string;
  readonly showConnect?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <SettingsSection title="Voice input">
      <SettingsRow
        title="Voice input"
        description={props.message}
        control={
          props.showConnect ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigate({ to: "/settings/connections" })}
            >
              Open Connections
            </Button>
          ) : null
        }
      />
    </SettingsSection>
  );
}

function DictionaryRow(props: {
  readonly dictionary: ReadonlyArray<string>;
  readonly onCommit: (dictionary: string[]) => void;
}) {
  const saved = props.dictionary.join("\n");
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <SettingsRow
      {...searchableSetting("voice-input-dictionary")}
      description="Names and terms to spell exactly, one per line."
    >
      <div className="px-3 pb-3 sm:px-4">
        <Textarea
          aria-label="Voice dictionary"
          rows={4}
          placeholder={"T3 Code\nKubernetes\nuseEffect"}
          value={draft ?? saved}
          onFocus={() => setDraft(saved)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            const next = draft === null ? null : parseVoiceDictionary(draft);
            setDraft(null);
            if (next !== null && next.join("\n") !== saved) props.onCommit(next);
          }}
        />
      </div>
    </SettingsRow>
  );
}

export function VoiceInputSettingsPanel() {
  const session = useAtomValue(managedRelaySessionAtom);
  const voice = useManagedRelayVoiceInput();
  const updateSettings = useAtomCommand(updateManagedRelayVoiceInputSettingsCommand, {
    label: "Save voice input settings",
  });
  const [pending, setPending] = useState<VoiceInputSettingsPatch | null>(null);

  const save = async (patch: VoiceInputSettingsPatch) => {
    if (!voice.accountId) return;
    setPending((current) => ({ ...current, ...patch }));
    await updateSettings({ accountId: voice.accountId, patch });
    setPending(null);
  };

  const content = (() => {
    if (!hasCloudPublicConfig()) {
      return (
        <VoiceInputUnavailable message="Voice input transcribes through T3 Connect, which this build does not include." />
      );
    }
    if (!session) {
      return (
        <VoiceInputUnavailable
          message="Sign in to T3 Connect to use voice input. Your settings and daily allowance follow your account."
          showConnect
        />
      );
    }
    if (voice.error && !voice.data) {
      return <VoiceInputUnavailable message={voice.error} />;
    }
    if (!voice.data) {
      return <VoiceInputUnavailable message="Loading…" />;
    }
    const status = voice.data;
    const settings = { ...status.settings, ...pending };
    return (
      <>
        {status.available ? null : (
          <VoiceInputUnavailable message="Voice input is turned off for T3 Connect right now. Your settings are kept." />
        )}
        <SettingsSection title="Transcription">
          <SettingsRow
            {...searchableSetting("voice-input-language")}
            description="The language you speak. Automatic detects it per recording."
            control={
              <Select
                value={settings.language ?? AUTOMATIC_LANGUAGE}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  void save({ language: value === AUTOMATIC_LANGUAGE ? null : value });
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Spoken language">
                  <SelectValue>{languageLabel(settings.language ?? null)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value={AUTOMATIC_LANGUAGE}>
                    Automatic
                  </SelectItem>
                  {VOICE_LANGUAGES.map((language) => (
                    <SelectItem key={language.code} hideIndicator value={language.code}>
                      {language.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            {...searchableSetting("voice-input-cleanup")}
            description="Fix punctuation and casing and drop filler words, without rewording."
            control={
              <Switch
                aria-label="Clean up transcripts"
                checked={settings.cleanup ?? true}
                onCheckedChange={(checked) => void save({ cleanup: checked })}
              />
            }
          />
          <DictionaryRow
            dictionary={settings.dictionary ?? []}
            onCommit={(dictionary) => void save({ dictionary })}
          />
        </SettingsSection>
        <SettingsSection title="Allowance">
          <SettingsRow
            {...searchableSetting("voice-input-usage")}
            description={`${formatMinutes(status.usedSecondsToday)} of ${formatMinutes(status.limits.dailySeconds)} minutes used today (resets at midnight UTC). Recordings stop after ${formatMinutes(status.limits.maxClipSeconds)} minutes.`}
          />
        </SettingsSection>
      </>
    );
  })();

  return <SettingsPageContainer>{content}</SettingsPageContainer>;
}
