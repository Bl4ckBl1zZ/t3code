import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const AudioTranscriptionFormat = Schema.Literals([
  "aac",
  "aiff",
  "flac",
  "m4a",
  "mp3",
  "ogg",
  "pcm16",
  "pcm24",
  "wav",
  "webm",
]);
export type AudioTranscriptionFormat = typeof AudioTranscriptionFormat.Type;

export const AudioTranscriptionInput = Schema.Struct({
  audioBase64: TrimmedNonEmptyString,
  existingText: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  format: AudioTranscriptionFormat,
  mimeType: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type AudioTranscriptionInput = typeof AudioTranscriptionInput.Type;

export const AudioTranscriptionResult = Schema.Struct({
  text: TrimmedString,
});
export type AudioTranscriptionResult = typeof AudioTranscriptionResult.Type;

export class AudioTranscriptionError extends Schema.TaggedErrorClass<AudioTranscriptionError>()(
  "AudioTranscriptionError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}
