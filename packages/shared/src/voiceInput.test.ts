import { describe, expect, it } from "vite-plus/test";

import {
  insertVoiceTranscript,
  normalizeVoiceDictionary,
  transformTextRange,
  undoVoiceInsertion,
} from "./voiceInput.ts";

describe("voice draft insertion", () => {
  it.each([
    ["", { start: 0, end: 0 }, "Hello.", "Hello."],
    ["world", { start: 0, end: 0 }, "Hello", "Hello world"],
    ["Hello world", { start: 6, end: 11 }, "T3", "Hello T3"],
    ["Hello", { start: 5, end: 5 }, "world", "Hello world"],
  ] as const)("inserts at the intended range", (draft, range, transcript, expected) => {
    expect(
      insertVoiceTranscript({ draft, range, rawText: transcript, cleanedText: transcript }).text,
    ).toBe(expected);
  });

  it("transforms an anchor across safe edits and rejects overlapping edits", () => {
    expect(
      transformTextRange({ start: 5, end: 5 }, { start: 0, end: 0, insertedText: "Hi " }),
    ).toEqual({ start: 8, end: 8 });
    expect(
      transformTextRange({ start: 3, end: 8 }, { start: 5, end: 6, insertedText: "x" }),
    ).toBeNull();
  });

  it("undoes only while the inserted range remains intact", () => {
    const result = insertVoiceTranscript({
      draft: "Hello friend",
      range: { start: 6, end: 12 },
      rawText: "world",
      cleanedText: "World.",
    });
    expect(undoVoiceInsertion(result.text, result.recovery)).toEqual({
      text: "Hello friend",
      caret: 12,
    });
    expect(undoVoiceInsertion(`${result.text}!`, result.recovery)?.text).toBe("Hello friend!");
    expect(undoVoiceInsertion("Hello edited", result.recovery)).toBeNull();
  });

  it("deduplicates dictionary entries case-insensitively while preserving casing", () => {
    expect(normalizeVoiceDictionary([" T3 Code ", "t3 code", "", "OpenRouter"])).toEqual([
      "T3 Code",
      "OpenRouter",
    ]);
  });
});
