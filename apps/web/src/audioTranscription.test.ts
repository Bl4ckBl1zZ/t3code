import { describe, expect, it } from "vitest";
import {
  appendTranscriptionToPrompt,
  audioMimeTypeToTranscriptionFormat,
} from "./audioTranscription";

describe("audio transcription helpers", () => {
  it("appends dictated text with a natural separator", () => {
    expect(appendTranscriptionToPrompt("", "  Fix the build. ")).toBe("Fix the build.");
    expect(appendTranscriptionToPrompt("Check this", "and update the tests.")).toBe(
      "Check this and update the tests.",
    );
    expect(appendTranscriptionToPrompt("Check this\n", "Then update the tests.")).toBe(
      "Check this\nThen update the tests.",
    );
  });

  it("keeps punctuation and open delimiters tight", () => {
    expect(appendTranscriptionToPrompt("Ship it", ".")).toBe("Ship it.");
    expect(appendTranscriptionToPrompt("Use (", "the new model)")).toBe("Use (the new model)");
  });

  it("maps browser recording MIME types to OpenRouter audio formats", () => {
    expect(audioMimeTypeToTranscriptionFormat("audio/webm;codecs=opus")).toBe("webm");
    expect(audioMimeTypeToTranscriptionFormat("audio/mp4")).toBe("m4a");
    expect(audioMimeTypeToTranscriptionFormat("audio/mpeg")).toBe("mp3");
  });
});
