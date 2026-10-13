import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const VOICE_INPUT_MAX_DICTIONARY_ENTRIES = 200;
export const VOICE_INPUT_MAX_DICTIONARY_ENTRY_LENGTH = 80;

export const VoiceInputDictionaryEntry = TrimmedNonEmptyString.check(
  Schema.isMaxLength(VOICE_INPUT_MAX_DICTIONARY_ENTRY_LENGTH),
);

const VoiceInputDictionary = Schema.Array(VoiceInputDictionaryEntry).check(
  Schema.isMaxLength(VOICE_INPUT_MAX_DICTIONARY_ENTRIES),
);

/** Per-account voice preferences. They live on the relay so they follow the account. */
export const VoiceInputSettings = Schema.Struct({
  /** Spoken-language hint such as "en" or "de"; null lets the model detect it. */
  language: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(35))),
  /** Names and terms the transcript should spell this way. */
  dictionary: VoiceInputDictionary,
  /** Fix punctuation, casing, and filler words without changing meaning. */
  cleanup: Schema.Boolean,
});
export type VoiceInputSettings = typeof VoiceInputSettings.Type;

export const DEFAULT_VOICE_INPUT_SETTINGS: VoiceInputSettings = {
  language: null,
  dictionary: [],
  cleanup: true,
};

export const VoiceInputSettingsPatch = Schema.Struct({
  language: Schema.optionalKey(VoiceInputSettings.fields.language),
  dictionary: Schema.optionalKey(VoiceInputDictionary),
  cleanup: Schema.optionalKey(Schema.Boolean),
});
export type VoiceInputSettingsPatch = typeof VoiceInputSettingsPatch.Type;

/** Operator-configured caps, so clients can stop a recording before the relay rejects it. */
export const VoiceInputLimits = Schema.Struct({
  maxClipSeconds: PositiveInt,
  maxUploadBytes: PositiveInt,
  dailySeconds: PositiveInt,
});
export type VoiceInputLimits = typeof VoiceInputLimits.Type;

export const VoiceInputStatus = Schema.Struct({
  /** False when the operator turned voice off or configured no transcription key. */
  available: Schema.Boolean,
  settings: VoiceInputSettings,
  limits: VoiceInputLimits,
  /** Audio seconds this account used in the current UTC day. */
  usedSecondsToday: NonNegativeInt,
});
export type VoiceInputStatus = typeof VoiceInputStatus.Type;

/** Containers the transcription model accepts. Browsers record WebM, so web sends WAV. */
export const VoiceAudioFormat = Schema.Literals(["wav", "m4a", "mp3", "ogg", "aac", "flac"]);
export type VoiceAudioFormat = typeof VoiceAudioFormat.Type;

export const VoiceTranscriptionRequest = Schema.Struct({
  /** Retrying with the same id returns the first result instead of transcribing again. */
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(191)),
  audio: Schema.Struct({
    /** Base64 without a data: prefix. */
    data: Schema.String.check(Schema.isNonEmpty()),
    format: VoiceAudioFormat,
  }),
  /** Recorded length. The relay measures WAV itself and trusts this for other formats. */
  durationSeconds: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  /** Overrides the account's cleanup setting for this recording. */
  cleanup: Schema.optionalKey(Schema.Boolean),
});
export type VoiceTranscriptionRequest = typeof VoiceTranscriptionRequest.Type;

export const VoiceTranscriptionResponse = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  text: Schema.String,
  cleanupApplied: Schema.Boolean,
  /** Seconds counted against the daily cap. */
  billedSeconds: NonNegativeInt,
});
export type VoiceTranscriptionResponse = typeof VoiceTranscriptionResponse.Type;

export const RelayVoiceInputErrorCode = Schema.Literals([
  /** The operator turned voice off, configured no key, or the key stopped working. */
  "voice_unavailable",
  "invalid_audio",
  "audio_too_large",
  "clip_too_long",
  "daily_limit_reached",
  "no_speech",
  "rate_limited",
  "transcription_failed",
]);
export type RelayVoiceInputErrorCode = typeof RelayVoiceInputErrorCode.Type;
