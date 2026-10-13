import { describe, expect, it } from "vite-plus/test";

import { voiceTranscriptInsertion } from "./voiceTranscriptInsertion";

describe("voiceTranscriptInsertion", () => {
  it("separates English words from the text around the caret", () => {
    expect(
      voiceTranscriptInsertion({
        value: "Fix the cache.",
        position: 14,
        transcript: "  Then run the tests. ",
        locale: "en-US",
      }),
    ).toBe(" Then run the tests.");
    expect(
      voiceTranscriptInsertion({
        value: "Fix tests",
        position: 4,
        transcript: "all",
        locale: "en",
      }),
    ).toBe("all ");
  });

  it("does not add spaces for languages written without them", () => {
    expect(
      voiceTranscriptInsertion({ value: "修正", position: 2, transcript: "テスト", locale: "ja" }),
    ).toBe("テスト");
  });

  it("returns null for a blank transcript", () => {
    expect(
      voiceTranscriptInsertion({ value: "", position: 0, transcript: "   ", locale: "en" }),
    ).toBeNull();
  });
});
