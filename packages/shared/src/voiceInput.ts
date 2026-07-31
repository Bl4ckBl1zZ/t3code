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

export type DraftEdit = TextRange & {
  readonly insertedText: string;
};

export type VoiceInsertionRecovery = {
  readonly insertedRange: TextRange;
  readonly priorText: string;
  readonly rawText: string;
  readonly cleanedText: string;
};

export type VoiceInsertionResult = {
  readonly text: string;
  readonly caret: number;
  readonly recovery: VoiceInsertionRecovery;
};

function clampRange(range: TextRange, textLength: number): TextRange {
  const start = Math.max(0, Math.min(range.start, textLength));
  const end = Math.max(start, Math.min(range.end, textLength));
  return { start, end };
}

export function transformTextRange(range: TextRange, edit: DraftEdit): TextRange | null {
  const removedLength = edit.end - edit.start;
  const delta = edit.insertedText.length - removedLength;

  if (edit.end <= range.start) {
    return { start: range.start + delta, end: range.end + delta };
  }
  if (edit.start >= range.end) {
    return range;
  }
  if (range.start === range.end && edit.start === range.start && edit.end === range.end) {
    return {
      start: range.start + edit.insertedText.length,
      end: range.end + edit.insertedText.length,
    };
  }
  return null;
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
  readonly rawText: string;
  readonly cleanedText: string;
}): VoiceInsertionResult {
  const range = clampRange(input.range, input.draft.length);
  const insertedText = insertionWithBoundaryWhitespace(input.draft, range, input.cleanedText);
  const text = `${input.draft.slice(0, range.start)}${insertedText}${input.draft.slice(range.end)}`;
  const insertedRange = { start: range.start, end: range.start + insertedText.length };
  return {
    text,
    caret: insertedRange.end,
    recovery: {
      insertedRange,
      priorText: input.draft.slice(range.start, range.end),
      rawText: input.rawText,
      cleanedText: input.cleanedText,
    },
  };
}

export function replaceVoiceInsertionWithRaw(
  draft: string,
  recovery: VoiceInsertionRecovery,
): VoiceInsertionResult | null {
  const range = clampRange(recovery.insertedRange, draft.length);
  if (draft.slice(range.start, range.end).trim() !== recovery.cleanedText.trim()) {
    return null;
  }
  return insertVoiceTranscript({
    draft,
    range,
    rawText: recovery.rawText,
    cleanedText: recovery.rawText,
  });
}

export function undoVoiceInsertion(
  draft: string,
  recovery: VoiceInsertionRecovery,
): { readonly text: string; readonly caret: number } | null {
  const range = clampRange(recovery.insertedRange, draft.length);
  if (draft.slice(range.start, range.end).trim() !== recovery.cleanedText.trim()) return null;
  return {
    text: `${draft.slice(0, range.start)}${recovery.priorText}${draft.slice(range.end)}`,
    caret: range.start + recovery.priorText.length,
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
    transcriptionModel: patch.transcriptionModel ?? settings.transcriptionModel,
    language: patch.language === undefined ? settings.language : patch.language,
    cleanup: {
      enabled: patch.cleanup?.enabled ?? settings.cleanup.enabled,
      model: patch.cleanup?.model ?? settings.cleanup.model,
    },
    dictionary:
      patch.dictionary === undefined
        ? settings.dictionary
        : [...normalizeVoiceDictionary(patch.dictionary)],
  };
}
