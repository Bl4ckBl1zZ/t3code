import { describe, expect, it } from "vite-plus/test";
import { createAssistantTextSelector, findAssistantCitationText } from "./assistantTextSelection";

describe("assistant quote selectors", () => {
  it("retains selected code whitespace but locates normalized rendered text after reflow", () => {
    const text = "Before.\nUse 🚀\n  carefully.\nAfter.";
    const start = text.indexOf("Use");
    const selector = createAssistantTextSelector(text, start, text.indexOf("\nAfter."))!;
    expect(selector).toEqual({
      text: "Use 🚀\n  carefully.",
      start: 8,
      end: 25,
      prefix: "Before. ",
      suffix: " After.",
    });
    expect(
      findAssistantCitationText("Inserted. Before. Use 🚀 carefully. After.", selector),
    ).toEqual({ start: 18, end: 35 });
  });
  it("refuses to guess between repeated quotes with identical context", () => {
    expect(
      findAssistantCitationText("quote quote", {
        text: "quote",
        start: 0,
        end: 5,
        prefix: "",
        suffix: "",
      }),
    ).toBeNull();
    expect(
      findAssistantCitationText("one quote two quote three", {
        text: "quote",
        start: 0,
        end: 5,
        prefix: "two ",
        suffix: " three",
      }),
    ).toEqual({ start: 14, end: 19 });
  });
  it("falls back to a unique quote when its surroundings changed", () => {
    expect(
      findAssistantCitationText("New surrounding quote content", {
        text: "quote",
        start: 0,
        end: 5,
        prefix: "old ",
        suffix: " context",
      }),
    ).toEqual({ start: 16, end: 21 });
  });
});
