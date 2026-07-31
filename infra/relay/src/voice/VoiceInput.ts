// @effect-diagnostics globalFetch:off
// @effect-diagnostics cryptoRandomUUID:off
import type {
  OpenRouterIntegrationStatus,
  OpenRouterModelCapability,
  OpenRouterModelOption,
  VoiceAudioFormat,
  VoiceInputSettings,
  VoiceInputSettingsPatch,
  VoiceTranscriptionErrorCode,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResponse,
} from "@t3tools/contracts/voice";
import {
  DEFAULT_VOICE_INPUT_SETTINGS,
  VOICE_INPUT_MAX_AUDIO_BYTES,
} from "@t3tools/contracts/voice";
import { applyVoiceInputSettingsPatch, normalizeVoiceDictionary } from "@t3tools/shared/voiceInput";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { and, eq } from "drizzle-orm";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import {
  relayAccountIntegrations,
  relayVoiceInputSettings,
  relayVoiceTranscriptionRequests,
} from "../persistence/schema.ts";

const OPENROUTER_ORIGIN = "https://openrouter.ai";
const OPENROUTER_TRANSCRIPTION_MODELS: ReadonlyArray<OpenRouterModelOption> = [
  {
    id: "openai/gpt-4o-mini-transcribe",
    name: "OpenAI: GPT-4o Mini Transcribe",
    providerName: "OpenAI",
    capability: "transcription",
    available: true,
  },
  {
    id: "openai/gpt-4o-transcribe",
    name: "OpenAI: GPT-4o Transcribe",
    providerName: "OpenAI",
    capability: "transcription",
    available: true,
  },
];
const OPENROUTER_TRANSCRIPTION_MODEL_IDS = new Set(
  OPENROUTER_TRANSCRIPTION_MODELS.map((model) => model.id),
);
const modelCache = new Map<
  OpenRouterModelCapability,
  { readonly models: ReadonlyArray<OpenRouterModelOption>; readonly cachedAt: number }
>();

export class VoiceInputOperationError extends Schema.TaggedErrorClass<VoiceInputOperationError>()(
  "VoiceInputOperationError",
  {
    code: Schema.Union([
      Schema.Literal("persistence_failed"),
      Schema.Literal("integration_unavailable"),
      Schema.Literal("unauthenticated"),
      Schema.Literal("integration_not_configured"),
      Schema.Literal("credential_invalid"),
      Schema.Literal("invalid_audio"),
      Schema.Literal("audio_too_large"),
      Schema.Literal("duration_exceeded"),
      Schema.Literal("no_speech"),
      Schema.Literal("unsupported_format"),
      Schema.Literal("model_unavailable"),
      Schema.Literal("rate_limited"),
      Schema.Literal("provider_payment_required"),
      Schema.Literal("transcription_failed"),
      Schema.Literal("request_aborted"),
    ]),
    retryAfterSeconds: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

type VoiceErrorCode =
  | VoiceTranscriptionErrorCode
  | "persistence_failed"
  | "integration_unavailable";

function operationError(
  code: VoiceErrorCode,
  options?: { readonly retryAfterSeconds?: number; readonly cause?: unknown },
): VoiceInputOperationError {
  return new VoiceInputOperationError({
    code,
    ...(options?.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: options.retryAfterSeconds }),
    ...(options && "cause" in options ? { cause: options.cause } : {}),
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptCredential(secret: string, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    new TextEncoder().encode(value) as BufferSource,
  );
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

async function decryptCredential(secret: string, value: string): Promise<string> {
  const [version, iv, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !ciphertext) throw new Error("Unsupported ciphertext");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) as BufferSource },
    await encryptionKey(secret),
    base64ToBytes(ciphertext) as BufferSource,
  );
  return new TextDecoder().decode(decrypted);
}

function credentialHint(apiKey: string): string {
  return `…${apiKey.slice(-4)}`;
}

function decodedBase64Size(data: string): number {
  const normalized = data.replace(/\s/gu, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 !== 0) return -1;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return (normalized.length / 4) * 3 - padding;
}

function upstreamErrorMessage(payload: string): string | undefined {
  try {
    const decoded: unknown = JSON.parse(payload);
    if (typeof decoded !== "object" || decoded === null || !("error" in decoded)) return undefined;
    const error = decoded.error;
    if (typeof error === "string") return error.slice(0, 300);
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      return error.message.slice(0, 300);
    }
  } catch {
    // Non-JSON upstream error pages are represented by status only.
  }
  return undefined;
}

async function upstreamError(response: Response): Promise<VoiceInputOperationError> {
  const retryAfter = Number(response.headers.get("retry-after"));
  const providerMessage = upstreamErrorMessage(await response.text());
  const options = {
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
    cause: new Error(
      `OpenRouter returned HTTP ${response.status}${providerMessage ? `: ${providerMessage}` : ""}`,
    ),
  };
  switch (response.status) {
    case 401:
    case 403:
      return operationError("credential_invalid", options);
    case 402:
      return operationError("provider_payment_required", options);
    case 400:
      if (providerMessage?.toLowerCase().includes("model") && providerMessage.includes("exist")) {
        return operationError("model_unavailable", options);
      }
      return operationError("invalid_audio", options);
    case 422:
      return operationError("invalid_audio", options);
    case 408:
      return operationError("request_aborted", options);
    case 413:
      return operationError("audio_too_large", options);
    case 415:
      return operationError("unsupported_format", options);
    case 404:
    case 500:
    case 502:
    case 503:
    case 504:
      return operationError("model_unavailable", options);
    case 429:
      return operationError("rate_limited", options);
    default:
      return operationError("transcription_failed", options);
  }
}

async function openRouterJson(input: {
  readonly apiKey: string;
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}): Promise<unknown> {
  const response = await fetch(`${OPENROUTER_ORIGIN}${input.path}`, {
    method: input.method ?? "GET",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) throw await upstreamError(response);
  return response.json();
}

function integrationStatus(
  row:
    | {
        readonly credentialCiphertext: string | null;
        readonly credentialHint: string | null;
        readonly state: OpenRouterIntegrationStatus["state"];
        readonly lastValidatedAt: string | null;
        readonly errorCode: string | null;
      }
    | undefined,
): OpenRouterIntegrationStatus {
  if (!row?.credentialCiphertext) return { configured: false, state: "not_configured" };
  return {
    configured: true,
    state: row.state,
    ...(row.credentialHint ? { credentialHint: row.credentialHint } : {}),
    ...(row.lastValidatedAt ? { lastValidatedAt: row.lastValidatedAt } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
  };
}

function providerName(modelId: string): string {
  const author = modelId.split("/")[0] ?? modelId;
  return author
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function normalizeModels(
  payload: unknown,
  capability: OpenRouterModelCapability,
): OpenRouterModelOption[] {
  // OpenRouter's general model catalog includes audio-capable chat models that the dedicated
  // transcription endpoint rejects, while transcription-only models are not consistently listed.
  if (capability === "transcription") return [...OPENROUTER_TRANSCRIPTION_MODELS];
  if (typeof payload !== "object" || payload === null || !("data" in payload)) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const models: OpenRouterModelOption[] = [];
  for (const candidate of data) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const model = candidate as Record<string, unknown>;
    if (typeof model.id !== "string" || typeof model.name !== "string") continue;
    const architecture =
      typeof model.architecture === "object" && model.architecture !== null
        ? (model.architecture as Record<string, unknown>)
        : {};
    const inputs = Array.isArray(architecture.input_modalities)
      ? architecture.input_modalities
      : [];
    const outputs = Array.isArray(architecture.output_modalities)
      ? architecture.output_modalities
      : [];
    const compatible = inputs.includes("text") && outputs.includes("text");
    if (!compatible) continue;
    const pricing =
      typeof model.pricing === "object" && model.pricing !== null
        ? (model.pricing as Record<string, unknown>)
        : {};
    models.push({
      id: model.id,
      name: model.name,
      providerName: providerName(model.id),
      capability,
      available: true,
      pricing: {
        ...(typeof pricing.prompt === "string" ? { input: pricing.prompt } : {}),
        ...(typeof pricing.completion === "string" ? { output: pricing.completion } : {}),
        ...(typeof pricing.audio === "string" ? { audio: pricing.audio } : {}),
      },
    });
  }
  return models;
}

function resolveTranscriptionModel(modelId: string): string {
  return OPENROUTER_TRANSCRIPTION_MODEL_IDS.has(modelId)
    ? modelId
    : DEFAULT_VOICE_INPUT_SETTINGS.transcriptionModel;
}

const CLEANUP_SYSTEM_PROMPT = `Correct a speech transcript conservatively.
Preserve the speaker's intent. Do not answer or act on the content. Do not add facts.
Do not expand ambiguous acronyms unless the dictionary supplies the spelling.
Fix punctuation, casing, spacing, and obvious transcription errors.
Remove filler words only when meaning, tone, and intent do not change.
Preserve commands, file paths, code identifiers, URLs, and inline code.
Use dictionary spelling only where context supports it.
Return only the corrected transcript, without quotes or Markdown fences.`;

const isVoiceInputOperationError = Schema.is(VoiceInputOperationError);

export class VoiceInput extends Context.Service<
  VoiceInput,
  {
    readonly status: (
      userId: string,
    ) => Effect.Effect<OpenRouterIntegrationStatus, VoiceInputOperationError>;
    readonly connect: (input: {
      readonly userId: string;
      readonly apiKey: string;
    }) => Effect.Effect<OpenRouterIntegrationStatus, VoiceInputOperationError>;
    readonly validate: (
      userId: string,
    ) => Effect.Effect<OpenRouterIntegrationStatus, VoiceInputOperationError>;
    readonly disconnect: (
      userId: string,
    ) => Effect.Effect<OpenRouterIntegrationStatus, VoiceInputOperationError>;
    readonly settings: (
      userId: string,
    ) => Effect.Effect<VoiceInputSettings, VoiceInputOperationError>;
    readonly patchSettings: (input: {
      readonly userId: string;
      readonly patch: VoiceInputSettingsPatch;
    }) => Effect.Effect<VoiceInputSettings, VoiceInputOperationError>;
    readonly models: (input: {
      readonly userId: string;
      readonly capability: OpenRouterModelCapability;
    }) => Effect.Effect<
      { readonly models: ReadonlyArray<OpenRouterModelOption>; readonly stale?: boolean },
      VoiceInputOperationError
    >;
    readonly transcribe: (input: {
      readonly userId: string;
      readonly request: VoiceTranscriptionRequest;
    }) => Effect.Effect<VoiceTranscriptionResponse, VoiceInputOperationError>;
  }
>()("t3code-relay/voice/VoiceInput") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const secret = config.voiceCredentialEncryptionKey;

  const readIntegration = Effect.fn("relay.voice.read_integration")(function* (userId: string) {
    return yield* db
      .select()
      .from(relayAccountIntegrations)
      .where(
        and(
          eq(relayAccountIntegrations.userId, userId),
          eq(relayAccountIntegrations.integrationId, "openrouter"),
        ),
      )
      .limit(1)
      .pipe(
        Effect.map((rows) => rows[0]),
        Effect.mapError((cause) => operationError("persistence_failed", { cause })),
      );
  });

  const readCredential = Effect.fn("relay.voice.read_credential")(function* (userId: string) {
    if (!secret) return yield* operationError("integration_unavailable");
    const row = yield* readIntegration(userId);
    if (!row?.credentialCiphertext) return yield* operationError("integration_not_configured");
    return yield* Effect.tryPromise({
      try: () => decryptCredential(Redacted.value(secret), row.credentialCiphertext!),
      catch: (cause) => operationError("credential_invalid", { cause }),
    });
  });

  const readSettings = Effect.fn("relay.voice.read_settings")(function* (userId: string) {
    return yield* db
      .select()
      .from(relayVoiceInputSettings)
      .where(eq(relayVoiceInputSettings.userId, userId))
      .limit(1)
      .pipe(
        Effect.map((rows) => rows[0]?.settingsJson ?? DEFAULT_VOICE_INPUT_SETTINGS),
        Effect.mapError((cause) => operationError("persistence_failed", { cause })),
      );
  });

  const saveStatus = Effect.fn("relay.voice.save_status")(function* (input: {
    readonly userId: string;
    readonly credentialCiphertext: string;
    readonly hint: string;
    readonly state: OpenRouterIntegrationStatus["state"];
    readonly errorCode?: string;
  }) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* db
      .insert(relayAccountIntegrations)
      .values({
        userId: input.userId,
        integrationId: "openrouter",
        credentialCiphertext: input.credentialCiphertext,
        credentialHint: input.hint,
        state: input.state,
        lastValidatedAt: now,
        errorCode: input.errorCode ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [relayAccountIntegrations.userId, relayAccountIntegrations.integrationId],
        set: {
          credentialCiphertext: input.credentialCiphertext,
          credentialHint: input.hint,
          state: input.state,
          lastValidatedAt: now,
          errorCode: input.errorCode ?? null,
          updatedAt: now,
        },
      })
      .pipe(Effect.mapError((cause) => operationError("persistence_failed", { cause })));
    return integrationStatus({
      credentialCiphertext: input.credentialCiphertext,
      credentialHint: input.hint,
      state: input.state,
      lastValidatedAt: now,
      errorCode: input.errorCode ?? null,
    });
  });

  const status = Effect.fn("relay.voice.status")(function* (userId: string) {
    return integrationStatus(yield* readIntegration(userId));
  });

  const connect = Effect.fn("relay.voice.connect")(function* (input: {
    readonly userId: string;
    readonly apiKey: string;
  }) {
    if (!secret) return yield* operationError("integration_unavailable");
    yield* Effect.tryPromise({
      try: () => openRouterJson({ apiKey: input.apiKey, path: "/api/v1/key" }),
      catch: (cause) =>
        isVoiceInputOperationError(cause) ? cause : operationError("credential_invalid", { cause }),
    });
    const ciphertext = yield* Effect.tryPromise({
      try: () => encryptCredential(Redacted.value(secret), input.apiKey),
      catch: (cause) => operationError("integration_unavailable", { cause }),
    });
    return yield* saveStatus({
      userId: input.userId,
      credentialCiphertext: ciphertext,
      hint: credentialHint(input.apiKey),
      state: "connected",
    });
  });

  const validate = Effect.fn("relay.voice.validate")(function* (userId: string) {
    const row = yield* readIntegration(userId);
    const apiKey = yield* readCredential(userId);
    try {
      yield* Effect.promise(() => openRouterJson({ apiKey, path: "/api/v1/key" }));
      return yield* saveStatus({
        userId,
        credentialCiphertext: row!.credentialCiphertext!,
        hint: row!.credentialHint ?? credentialHint(apiKey),
        state: "connected",
      });
    } catch (cause) {
      return yield* saveStatus({
        userId,
        credentialCiphertext: row!.credentialCiphertext!,
        hint: row!.credentialHint ?? credentialHint(apiKey),
        state:
          isVoiceInputOperationError(cause) && cause.code === "credential_invalid"
            ? "invalid"
            : "unavailable",
        errorCode: isVoiceInputOperationError(cause) ? cause.code : "validation_failed",
      });
    }
  });

  const disconnect = Effect.fn("relay.voice.disconnect")(function* (userId: string) {
    yield* db
      .delete(relayAccountIntegrations)
      .where(
        and(
          eq(relayAccountIntegrations.userId, userId),
          eq(relayAccountIntegrations.integrationId, "openrouter"),
        ),
      )
      .pipe(Effect.mapError((cause) => operationError("persistence_failed", { cause })));
    return { configured: false, state: "not_configured" as const };
  });

  const patchSettings = Effect.fn("relay.voice.patch_settings")(function* (input: {
    readonly userId: string;
    readonly patch: VoiceInputSettingsPatch;
  }) {
    const current = yield* readSettings(input.userId);
    const settings = applyVoiceInputSettingsPatch(current, {
      ...input.patch,
      ...(input.patch.dictionary === undefined
        ? {}
        : { dictionary: [...normalizeVoiceDictionary(input.patch.dictionary)] }),
    });
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* db
      .insert(relayVoiceInputSettings)
      .values({ userId: input.userId, settingsJson: settings, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: relayVoiceInputSettings.userId,
        set: { settingsJson: settings, updatedAt: now },
      })
      .pipe(Effect.mapError((cause) => operationError("persistence_failed", { cause })));
    return settings;
  });

  const models = Effect.fn("relay.voice.models")(function* (input: {
    readonly userId: string;
    readonly capability: OpenRouterModelCapability;
  }) {
    const apiKey = yield* readCredential(input.userId);
    const result = yield* Effect.tryPromise({
      try: () => openRouterJson({ apiKey, path: "/api/v1/models" }),
      catch: (cause) =>
        isVoiceInputOperationError(cause)
          ? cause
          : operationError("transcription_failed", { cause }),
    }).pipe(
      Effect.map((payload) => ({ _tag: "fresh" as const, payload })),
      Effect.catch((error) => {
        const cached = modelCache.get(input.capability);
        return cached
          ? Effect.succeed({ _tag: "cached" as const, models: cached.models })
          : Effect.fail(error);
      }),
    );
    if (result._tag === "cached") return { models: result.models, stale: true };
    const normalized = normalizeModels(result.payload, input.capability);
    const cachedAt = yield* Clock.currentTimeMillis;
    modelCache.set(input.capability, { models: normalized, cachedAt });
    return { models: normalized };
  });

  const transcribe = Effect.fn("relay.voice.transcribe")(function* (input: {
    readonly userId: string;
    readonly request: VoiceTranscriptionRequest;
  }) {
    const existing = yield* db
      .select()
      .from(relayVoiceTranscriptionRequests)
      .where(
        and(
          eq(relayVoiceTranscriptionRequests.userId, input.userId),
          eq(relayVoiceTranscriptionRequests.requestId, input.request.requestId),
        ),
      )
      .limit(1)
      .pipe(
        Effect.map((rows) => rows[0]?.responseJson),
        Effect.mapError((cause) => operationError("persistence_failed", { cause })),
      );
    if (existing) return existing;

    const audioBytes = decodedBase64Size(input.request.audio.data);
    if (audioBytes < 0) return yield* operationError("invalid_audio");
    if (audioBytes > VOICE_INPUT_MAX_AUDIO_BYTES) return yield* operationError("audio_too_large");

    const apiKey = yield* readCredential(input.userId);
    const settings = yield* readSettings(input.userId);
    const transcriptionModel = resolveTranscriptionModel(settings.transcriptionModel);
    const transcriptionPayload = yield* Effect.tryPromise({
      try: () =>
        openRouterJson({
          apiKey,
          path: "/api/v1/audio/transcriptions",
          method: "POST",
          body: {
            input_audio: {
              data: input.request.audio.data,
              format: input.request.audio.format satisfies VoiceAudioFormat,
            },
            model: transcriptionModel,
            ...(settings.language === null ? {} : { language: settings.language }),
          },
        }),
      catch: (cause) =>
        isVoiceInputOperationError(cause)
          ? cause
          : operationError("transcription_failed", { cause }),
    }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("OpenRouter transcription request failed").pipe(
          Effect.annotateLogs({
            "voice.error.code": error.code,
            "voice.error.cause": error.cause instanceof Error ? error.cause.message : "unknown",
            "voice.audio.format": input.request.audio.format,
            "voice.audio.bytes": audioBytes,
            "voice.transcription.model": transcriptionModel,
          }),
        ),
      ),
    );
    const rawText =
      typeof transcriptionPayload === "object" &&
      transcriptionPayload !== null &&
      "text" in transcriptionPayload &&
      typeof transcriptionPayload.text === "string"
        ? transcriptionPayload.text.trim()
        : "";
    if (!rawText) return yield* operationError("no_speech");

    const cleanupRequested = input.request.cleanup ?? settings.cleanup.enabled;
    let text = rawText;
    let cleanupApplied = false;
    let warning: "cleanup_failed" | undefined;
    let cleanupCostUsd: number | undefined;
    if (cleanupRequested) {
      try {
        const cleanupPayload = yield* Effect.promise(() =>
          openRouterJson({
            apiKey,
            path: "/api/v1/chat/completions",
            method: "POST",
            body: {
              model: settings.cleanup.model,
              messages: [
                { role: "system", content: CLEANUP_SYSTEM_PROMPT },
                {
                  role: "user",
                  // @effect-diagnostics-next-line preferSchemaOverJson:off
                  content: JSON.stringify({
                    transcript: rawText,
                    dictionary: settings.dictionary,
                  }),
                },
              ],
              temperature: 0,
            },
          }),
        );
        const candidate =
          typeof cleanupPayload === "object" &&
          cleanupPayload !== null &&
          "choices" in cleanupPayload &&
          Array.isArray(cleanupPayload.choices)
            ? cleanupPayload.choices[0]
            : undefined;
        const cleaned =
          typeof candidate === "object" &&
          candidate !== null &&
          "message" in candidate &&
          typeof candidate.message === "object" &&
          candidate.message !== null &&
          "content" in candidate.message &&
          typeof candidate.message.content === "string"
            ? candidate.message.content.trim()
            : "";
        if (!cleaned) throw new Error("Empty cleanup response");
        text = cleaned;
        cleanupApplied = true;
        const cleanupRecord =
          typeof cleanupPayload === "object" && cleanupPayload !== null
            ? (cleanupPayload as Record<string, unknown>)
            : {};
        if (
          typeof cleanupRecord.usage === "object" &&
          cleanupRecord.usage !== null &&
          "cost" in cleanupRecord.usage &&
          typeof cleanupRecord.usage.cost === "number"
        ) {
          cleanupCostUsd = cleanupRecord.usage.cost;
        }
      } catch {
        warning = "cleanup_failed";
      }
    }
    const usage =
      typeof transcriptionPayload === "object" &&
      transcriptionPayload !== null &&
      "usage" in transcriptionPayload &&
      typeof transcriptionPayload.usage === "object" &&
      transcriptionPayload.usage !== null
        ? (transcriptionPayload.usage as Record<string, unknown>)
        : {};
    const response: VoiceTranscriptionResponse = {
      requestId: input.request.requestId,
      rawText,
      text,
      cleanupApplied,
      ...(warning ? { warning } : {}),
      usage: {
        ...(typeof usage.seconds === "number" ? { audioSeconds: usage.seconds } : {}),
        ...(typeof usage.cost === "number" ? { transcriptionCostUsd: usage.cost } : {}),
        ...(cleanupCostUsd === undefined ? {} : { cleanupCostUsd }),
      },
    };
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* db
      .insert(relayVoiceTranscriptionRequests)
      .values({
        userId: input.userId,
        requestId: input.request.requestId,
        responseJson: response,
        createdAt: now,
      })
      .onConflictDoNothing()
      .pipe(Effect.mapError((cause) => operationError("persistence_failed", { cause })));
    return response;
  });

  return VoiceInput.of({
    status,
    connect,
    validate,
    disconnect,
    settings: readSettings,
    patchSettings,
    models,
    transcribe,
  });
});

export const layer = Layer.effect(VoiceInput, make);

export const testExports = {
  CLEANUP_SYSTEM_PROMPT,
  decodedBase64Size,
  integrationStatus,
  normalizeModels,
  resolveTranscriptionModel,
  upstreamError,
};
