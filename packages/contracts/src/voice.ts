import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const VOICE_INPUT_MAX_DICTIONARY_ENTRIES = 250;
export const VOICE_INPUT_MAX_DICTIONARY_ENTRY_LENGTH = 80;
export const VOICE_INPUT_MAX_AUDIO_BYTES = 12 * 1024 * 1024;
export const VOICE_INPUT_MAX_DURATION_SECONDS = 120;

export const OpenRouterIntegrationState = Schema.Literals([
  "not_configured",
  "validating",
  "connected",
  "invalid",
  "unavailable",
]);
export type OpenRouterIntegrationState = typeof OpenRouterIntegrationState.Type;

export const OpenRouterIntegrationStatus = Schema.Struct({
  configured: Schema.Boolean,
  credentialHint: Schema.optionalKey(TrimmedNonEmptyString),
  state: OpenRouterIntegrationState,
  lastValidatedAt: Schema.optionalKey(TrimmedNonEmptyString),
  errorCode: Schema.optionalKey(TrimmedNonEmptyString),
});
export type OpenRouterIntegrationStatus = typeof OpenRouterIntegrationStatus.Type;

export const IntegrationSummary = Schema.Struct({
  id: Schema.Literal("openrouter"),
  name: TrimmedNonEmptyString,
  state: OpenRouterIntegrationState,
  configured: Schema.Boolean,
  usedBy: Schema.Array(TrimmedNonEmptyString),
});
export type IntegrationSummary = typeof IntegrationSummary.Type;

export const ListIntegrationsResponse = Schema.Struct({
  integrations: Schema.Array(IntegrationSummary),
});
export type ListIntegrationsResponse = typeof ListIntegrationsResponse.Type;

export const PutOpenRouterCredentialRequest = Schema.Struct({
  apiKey: TrimmedNonEmptyString,
});
export type PutOpenRouterCredentialRequest = typeof PutOpenRouterCredentialRequest.Type;

export const VoiceInputDictionaryEntry = TrimmedNonEmptyString.check(
  Schema.isMaxLength(VOICE_INPUT_MAX_DICTIONARY_ENTRY_LENGTH),
);

export const VoiceInputSettings = Schema.Struct({
  transcriptionModel: TrimmedNonEmptyString,
  language: Schema.NullOr(TrimmedNonEmptyString),
  cleanup: Schema.Struct({
    enabled: Schema.Boolean,
    model: TrimmedNonEmptyString,
  }),
  dictionary: Schema.Array(VoiceInputDictionaryEntry).check(
    Schema.isMaxLength(VOICE_INPUT_MAX_DICTIONARY_ENTRIES),
  ),
});
export type VoiceInputSettings = typeof VoiceInputSettings.Type;

export const DEFAULT_VOICE_INPUT_SETTINGS: VoiceInputSettings = {
  transcriptionModel: "openai/gpt-4o-mini-transcribe",
  language: null,
  cleanup: {
    enabled: true,
    model: "openai/gpt-4.1-mini",
  },
  dictionary: [],
};

export const VoiceInputSettingsPatch = Schema.Struct({
  transcriptionModel: Schema.optionalKey(TrimmedNonEmptyString),
  language: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  cleanup: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      model: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
  dictionary: Schema.optionalKey(
    Schema.Array(VoiceInputDictionaryEntry).check(
      Schema.isMaxLength(VOICE_INPUT_MAX_DICTIONARY_ENTRIES),
    ),
  ),
});
export type VoiceInputSettingsPatch = typeof VoiceInputSettingsPatch.Type;

export const OpenRouterModelCapability = Schema.Literals(["transcription", "text"]);
export type OpenRouterModelCapability = typeof OpenRouterModelCapability.Type;

export const OpenRouterModelOption = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  providerName: TrimmedNonEmptyString,
  capability: OpenRouterModelCapability,
  available: Schema.Boolean,
  pricing: Schema.optionalKey(
    Schema.Struct({
      input: Schema.optionalKey(TrimmedNonEmptyString),
      output: Schema.optionalKey(TrimmedNonEmptyString),
      audio: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
});
export type OpenRouterModelOption = typeof OpenRouterModelOption.Type;

export const OpenRouterModelsResponse = Schema.Struct({
  models: Schema.Array(OpenRouterModelOption),
  stale: Schema.optionalKey(Schema.Boolean),
});
export type OpenRouterModelsResponse = typeof OpenRouterModelsResponse.Type;

export const VoiceAudioFormat = Schema.Literals(["webm", "m4a", "wav", "mp3", "ogg", "aac"]);
export type VoiceAudioFormat = typeof VoiceAudioFormat.Type;

export const VoiceTranscriptionRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  audio: Schema.Struct({
    data: TrimmedNonEmptyString,
    format: VoiceAudioFormat,
  }),
  cleanup: Schema.optionalKey(Schema.Boolean),
  durationSeconds: Schema.optionalKey(Schema.Number),
});
export type VoiceTranscriptionRequest = typeof VoiceTranscriptionRequest.Type;

export const VoiceTranscriptionWarning = Schema.Literal("cleanup_failed");
export type VoiceTranscriptionWarning = typeof VoiceTranscriptionWarning.Type;

export const VoiceTranscriptionResponse = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  rawText: Schema.String,
  text: Schema.String,
  cleanupApplied: Schema.Boolean,
  warning: Schema.optionalKey(VoiceTranscriptionWarning),
  usage: Schema.optionalKey(
    Schema.Struct({
      audioSeconds: Schema.optionalKey(Schema.Number),
      transcriptionCostUsd: Schema.optionalKey(Schema.Number),
      cleanupCostUsd: Schema.optionalKey(Schema.Number),
    }),
  ),
});
export type VoiceTranscriptionResponse = typeof VoiceTranscriptionResponse.Type;

export const VoiceTranscriptionErrorCode = Schema.Literals([
  "unauthenticated",
  "integration_not_configured",
  "credential_invalid",
  "invalid_audio",
  "audio_too_large",
  "duration_exceeded",
  "no_speech",
  "unsupported_format",
  "model_unavailable",
  "rate_limited",
  "provider_payment_required",
  "transcription_failed",
  "request_aborted",
]);
export type VoiceTranscriptionErrorCode = typeof VoiceTranscriptionErrorCode.Type;

export const VoiceTranscriptionError = Schema.Struct({
  code: VoiceTranscriptionErrorCode,
  message: Schema.optionalKey(TrimmedNonEmptyString),
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
});
export type VoiceTranscriptionError = typeof VoiceTranscriptionError.Type;
