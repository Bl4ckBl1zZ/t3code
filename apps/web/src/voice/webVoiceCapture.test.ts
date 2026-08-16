import { describe, expect, it } from "vite-plus/test";

import {
  isTranscribableFormat,
  selectRecordingMimeType,
  voiceFormatFromMimeType,
} from "./webVoiceCapture";

describe("voiceFormatFromMimeType", () => {
  it.each([
    ["audio/webm;codecs=opus", "webm"],
    ["audio/webm", "webm"],
    ["audio/mp4;codecs=mp4a.40.2", "m4a"],
    ["audio/mp4", "m4a"],
    ["video/mp4", "m4a"],
    ["audio/x-m4a", "m4a"],
    ["audio/ogg;codecs=opus", "ogg"],
    ["application/ogg", "ogg"],
    ["audio/mpeg", "mp3"],
    ["audio/wav", "wav"],
    ["audio/aac", "aac"],
    ["AUDIO/MP4", "m4a"],
  ] as const)("maps %s to %s", (mimeType, format) => {
    expect(voiceFormatFromMimeType(mimeType)).toBe(format);
  });

  it("returns null for unknown or empty types instead of guessing", () => {
    expect(voiceFormatFromMimeType("")).toBeNull();
    expect(voiceFormatFromMimeType("audio/3gpp")).toBeNull();
    expect(voiceFormatFromMimeType("text/plain")).toBeNull();
  });
});

describe("selectRecordingMimeType", () => {
  const supports =
    (...supported: ReadonlyArray<string>) =>
    (mimeType: string) =>
      supported.includes(mimeType);

  it("prefers m4a on Chromium, which also offers WebM the provider cannot read", () => {
    expect(
      selectRecordingMimeType(
        supports("audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"),
      ),
    ).toEqual({ mimeType: "audio/mp4;codecs=mp4a.40.2", format: "m4a" });
  });

  it("falls back to ogg on Firefox, which cannot record mp4", () => {
    expect(
      selectRecordingMimeType(supports("audio/webm;codecs=opus", "audio/ogg;codecs=opus")),
    ).toEqual({ mimeType: "audio/ogg;codecs=opus", format: "ogg" });
  });

  it("never selects WebM, which OpenRouter transcription rejects", () => {
    expect(
      selectRecordingMimeType(supports("audio/webm;codecs=opus", "audio/webm")),
    ).toBeUndefined();
  });

  it("selects plain audio/mp4 when the explicit AAC codec is unavailable", () => {
    expect(selectRecordingMimeType(supports("audio/mp4"))).toEqual({
      mimeType: "audio/mp4",
      format: "m4a",
    });
  });
});

describe("isTranscribableFormat", () => {
  it.each(["m4a", "ogg", "wav", "mp3", "aac"] as const)("accepts %s", (format) => {
    expect(isTranscribableFormat(format)).toBe(true);
  });

  it("rejects webm", () => {
    expect(isTranscribableFormat("webm")).toBe(false);
  });
});
