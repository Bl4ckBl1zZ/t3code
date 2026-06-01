import {
  AudioTranscriptionError,
  type AudioTranscriptionInput,
  type AudioTranscriptionResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { ServerSettingsShape } from "../serverSettings.ts";

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_HTTP_REFERER = "https://github.com/pingdotgg/t3code";
const OPENROUTER_X_TITLE = "T3 Code";

const OpenRouterChatResponse = Schema.Struct({
  choices: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        message: Schema.optionalKey(
          Schema.Struct({
            content: Schema.optionalKey(
              Schema.Union([
                Schema.String,
                Schema.Array(
                  Schema.Struct({
                    type: Schema.optionalKey(Schema.String),
                    text: Schema.optionalKey(Schema.String),
                  }),
                ),
              ]),
            ),
          }),
        ),
      }),
    ),
  ),
  error: Schema.optionalKey(
    Schema.Struct({
      message: Schema.optionalKey(Schema.String),
    }),
  ),
});
type OpenRouterChatResponse = typeof OpenRouterChatResponse.Type;

const decodeOpenRouterChatResponse = Schema.decodeEffect(
  Schema.fromJsonString(OpenRouterChatResponse),
);

export interface OpenRouterAudioTranscriptionShape {
  readonly transcribe: (
    input: AudioTranscriptionInput,
  ) => Effect.Effect<AudioTranscriptionResult, AudioTranscriptionError, HttpClient.HttpClient>;
}

export function makeOpenRouterAudioTranscription(
  serverSettings: ServerSettingsShape,
): OpenRouterAudioTranscriptionShape {
  const readSettings = serverSettings.getSettings.pipe(
    Effect.mapError(
      (cause) =>
        new AudioTranscriptionError({
          message: "Failed to read OpenRouter transcription settings.",
          cause,
        }),
    ),
  );

  const transcribe = (input: AudioTranscriptionInput) =>
    Effect.gen(function* () {
      const settings = yield* readSettings;
      const transcriptionSettings = settings.openRouter.audioTranscription;
      const apiKey = transcriptionSettings.apiKey.trim();
      if (!apiKey) {
        return yield* new AudioTranscriptionError({
          message: "Add an OpenRouter API key in Settings > Connections.",
        });
      }

      const payload = {
        model: transcriptionSettings.model,
        stream: false,
        temperature: 0,
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: buildAudioTranscriptionPrompt(input.existingText),
              },
              {
                type: "input_audio",
                input_audio: {
                  data: input.audioBase64,
                  format: input.format,
                },
              },
            ],
          },
        ],
      };

      const httpClient = yield* HttpClient.HttpClient;
      const request = HttpClientRequest.post(OPENROUTER_CHAT_COMPLETIONS_URL).pipe(
        HttpClientRequest.bearerToken(apiKey),
        HttpClientRequest.setHeader("HTTP-Referer", OPENROUTER_HTTP_REFERER),
        HttpClientRequest.setHeader("X-Title", OPENROUTER_X_TITLE),
        HttpClientRequest.bodyJsonUnsafe(payload),
      );
      const response = yield* httpClient.execute(request).pipe(
        Effect.mapError(
          (cause) =>
            new AudioTranscriptionError({
              message: "Failed to reach OpenRouter.",
              cause,
            }),
        ),
      );
      const responseText = yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new AudioTranscriptionError({
              message: "Failed to read OpenRouter response.",
              cause,
            }),
        ),
      );
      const responseJson = yield* decodeOpenRouterResponse(responseText).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );

      if (response.status < 200 || response.status >= 300) {
        return yield* new AudioTranscriptionError({
          message:
            responseJson?.error?.message ??
            `OpenRouter transcription failed with HTTP ${response.status}.`,
        });
      }

      if (!responseJson) {
        return yield* new AudioTranscriptionError({
          message: "OpenRouter returned an invalid transcription response.",
        });
      }

      const text = extractOpenRouterMessageText(responseJson).trim();
      if (!text) {
        return yield* new AudioTranscriptionError({
          message: "OpenRouter returned an empty transcription.",
        });
      }

      return { text };
    });

  return { transcribe } satisfies OpenRouterAudioTranscriptionShape;
}

function decodeOpenRouterResponse(
  responseText: string,
): Effect.Effect<OpenRouterChatResponse, AudioTranscriptionError> {
  return decodeOpenRouterChatResponse(responseText).pipe(
    Effect.mapError(
      (cause) =>
        new AudioTranscriptionError({
          message: "OpenRouter returned invalid JSON.",
          cause,
        }),
    ),
  );
}

function buildAudioTranscriptionPrompt(existingText: string): string {
  const trimmedExistingText = existingText.trim();
  const baseInstruction = [
    "Listen to the audio and produce the user's intended chat-composer text.",
    "Correct grammar, punctuation, and flow.",
    "Remove filler words, false starts, and repeated fragments.",
    "When the speaker misspeaks and corrects themselves, keep the corrected version.",
    "Return only the cleaned text. Do not wrap it in quotes or Markdown.",
  ].join(" ");

  if (!trimmedExistingText) {
    return baseInstruction;
  }

  return [
    baseInstruction,
    "The cleaned text will be appended after the existing draft below.",
    "Use the draft only for continuity and do not repeat it.",
    "",
    "Existing draft:",
    trimmedExistingText,
  ].join("\n");
}

function extractOpenRouterMessageText(response: OpenRouterChatResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => (part.type === "text" || part.type === undefined ? (part.text ?? "") : ""))
    .join("")
    .trim();
}
