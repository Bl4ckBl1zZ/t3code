import {
  VOICE_INPUT_MAX_DICTIONARY_ENTRIES,
  VOICE_INPUT_MAX_DICTIONARY_ENTRY_LENGTH,
  type VoiceInputSettings,
  type VoiceInputSettingsPatch,
} from "@t3tools/contracts/voice";

export type TextRange = {
  readonly start: number;
  readonly end: number;
};

export type VoiceInsertionResult = {
  readonly text: string;
  readonly caret: number;
};

function clampRange(range: TextRange, textLength: number): TextRange {
  const start = Math.max(0, Math.min(range.start, textLength));
  const end = Math.max(start, Math.min(range.end, textLength));
  return { start, end };
}

function insertionWithBoundaryWhitespace(
  draft: string,
  range: TextRange,
  transcript: string,
): string {
  const normalized = transcript.trim();
  if (!normalized) return "";
  const before = draft.slice(0, range.start);
  const after = draft.slice(range.end);
  const prefix =
    before.length > 0 && !/\s$/u.test(before) && !/^[\s,.;:!?)]/u.test(normalized) ? " " : "";
  const suffix = after.length > 0 && !/^\s/u.test(after) && !/[(\s]$/u.test(normalized) ? " " : "";
  return `${prefix}${normalized}${suffix}`;
}

export function insertVoiceTranscript(input: {
  readonly draft: string;
  readonly range: TextRange;
  readonly cleanedText: string;
}): VoiceInsertionResult {
  const range = clampRange(input.range, input.draft.length);
  const insertedText = insertionWithBoundaryWhitespace(input.draft, range, input.cleanedText);
  const text = `${input.draft.slice(0, range.start)}${insertedText}${input.draft.slice(range.end)}`;
  return {
    text,
    caret: range.start + insertedText.length,
  };
}

export function normalizeVoiceDictionary(entries: readonly string[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (!entry || Array.from(entry).length > VOICE_INPUT_MAX_DICTIONARY_ENTRY_LENGTH) continue;
    const key = entry.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
    if (result.length === VOICE_INPUT_MAX_DICTIONARY_ENTRIES) break;
  }
  return result;
}

export function applyVoiceInputSettingsPatch(
  settings: VoiceInputSettings,
  patch: VoiceInputSettingsPatch,
): VoiceInputSettings {
  return {
    model: patch.model ?? settings.model,
    language: patch.language === undefined ? settings.language : patch.language,
    cleanup: {
      enabled: patch.cleanup?.enabled ?? settings.cleanup.enabled,
    },
    dictionary:
      patch.dictionary === undefined
        ? settings.dictionary
        : [...normalizeVoiceDictionary(patch.dictionary)],
  };
}
