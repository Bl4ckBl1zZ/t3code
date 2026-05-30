import { describe, expect, it } from "vitest";

import {
  BROWSER_ANNOTATION_CAPTURE_MESSAGE,
  BROWSER_ANNOTATION_EXTENSION_SOURCE,
  browserAnnotationPrompt,
  estimateDataUrlByteSize,
  isBrowserAnnotationCaptureMessage,
} from "./browserAnnotation";

describe("isBrowserAnnotationCaptureMessage", () => {
  it("accepts annotation captures from the extension bridge", () => {
    expect(
      isBrowserAnnotationCaptureMessage({
        source: BROWSER_ANNOTATION_EXTENSION_SOURCE,
        type: BROWSER_ANNOTATION_CAPTURE_MESSAGE,
        text: "Tighten this spacing.",
        screenshotDataUrl: "data:image/png;base64,AAAA",
        pageUrl: "http://localhost:3000/",
        pageTitle: "Preview",
      }),
    ).toBe(true);
  });

  it("rejects empty annotation text and non-image payloads", () => {
    expect(
      isBrowserAnnotationCaptureMessage({
        source: BROWSER_ANNOTATION_EXTENSION_SOURCE,
        type: BROWSER_ANNOTATION_CAPTURE_MESSAGE,
        text: " ",
        screenshotDataUrl: "data:image/png;base64,AAAA",
        pageUrl: "http://localhost:3000/",
        pageTitle: "Preview",
      }),
    ).toBe(false);

    expect(
      isBrowserAnnotationCaptureMessage({
        source: BROWSER_ANNOTATION_EXTENSION_SOURCE,
        type: BROWSER_ANNOTATION_CAPTURE_MESSAGE,
        text: "Tighten this spacing.",
        screenshotDataUrl: "data:text/plain;base64,AAAA",
        pageUrl: "http://localhost:3000/",
        pageTitle: "Preview",
      }),
    ).toBe(false);
  });
});

describe("estimateDataUrlByteSize", () => {
  it("estimates base64 payload bytes", () => {
    expect(estimateDataUrlByteSize("data:image/png;base64,SGVsbG8=")).toBe(5);
  });

  it("estimates url-encoded payload bytes", () => {
    expect(estimateDataUrlByteSize("data:text/plain,Hello%20world")).toBe(11);
  });
});

describe("browserAnnotationPrompt", () => {
  it("adds page and element context to the user annotation", () => {
    expect(
      browserAnnotationPrompt({
        text: "Make this CTA more prominent.",
        pageUrl: "http://localhost:3000/",
        pageTitle: "Landing",
        selectorLabel: "button Upload a model",
      }),
    ).toBe(
      [
        "Make this CTA more prominent.",
        "",
        "Browser annotation:",
        "- Page: Landing",
        "- URL: http://localhost:3000/",
        "- Element: button Upload a model",
      ].join("\n"),
    );
  });
});
