import { describe, expect, it } from "vite-plus/test";

import { voiceFormatFromMimeType } from "./webVoiceCapture";

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
