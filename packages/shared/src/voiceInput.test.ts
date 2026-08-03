import { describe, expect, it } from "vite-plus/test";

import { insertVoiceTranscript, normalizeVoiceDictionary } from "./voiceInput.ts";

describe("voice draft insertion", () => {
  it.each([
    ["", { start: 0, end: 0 }, "Hello.", "Hello."],
    ["world", { start: 0, end: 0 }, "Hello", "Hello world"],
    ["Hello world", { start: 6, end: 11 }, "T3", "Hello T3"],
    ["Hello", { start: 5, end: 5 }, "world", "Hello world"],
  ] as const)("inserts at the intended range", (draft, range, transcript, expected) => {
    expect(insertVoiceTranscript({ draft, range, cleanedText: transcript }).text).toBe(expected);
  });

  it("places the caret at the end of the insertion", () => {
    const result = insertVoiceTranscript({
      draft: "Hello",
      range: { start: 5, end: 5 },
      cleanedText: "world",
    });
    expect(result.text).toBe("Hello world");
    expect(result.caret).toBe(11);
  });

  it("deduplicates dictionary entries case-insensitively while preserving casing", () => {
    expect(normalizeVoiceDictionary([" T3 Code ", "t3 code", "", "OpenRouter"])).toEqual([
      "T3 Code",
      "OpenRouter",
    ]);
  });
});
