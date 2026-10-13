import { describe, expect, it } from "vite-plus/test";

import { splitLegacyHtmlEmbedMarkdown } from "./legacyHtmlEmbed.ts";

describe("splitLegacyHtmlEmbedMarkdown", () => {
  it("leaves markdown without embeds whole", () => {
    const markdown = "Hello\n\n```ts\nconst a = 1;\n```\n";
    expect(splitLegacyHtmlEmbedMarkdown(markdown)).toEqual([
      { kind: "markdown", markdown, sourceOffset: 0 },
    ]);
  });

  it("splits a closed fence out between the text around it", () => {
    const markdown = "Before\n\n```t3-html\n<p>hi</p>\n<p>there</p>\n```\n\nAfter\n";
    expect(splitLegacyHtmlEmbedMarkdown(markdown)).toEqual([
      { kind: "markdown", markdown: "Before\n\n", sourceOffset: 0 },
      { kind: "html-embed", html: "<p>hi</p>\n<p>there</p>", sourceOffset: 8 },
      { kind: "markdown", markdown: "\nAfter\n", sourceOffset: 46 },
    ]);
  });

  it("finds every embed, with tildes, longer fences, and a case-insensitive info string", () => {
    const markdown = "~~~T3-HTML title\n<a></a>\n~~~\n````t3-html\n```\n<b></b>\n````";
    expect(
      splitLegacyHtmlEmbedMarkdown(markdown).map((segment) =>
        segment.kind === "html-embed" ? segment.html : `md:${segment.markdown}`,
      ),
    ).toEqual(["<a></a>", "```\n<b></b>"]);
  });

  it("keeps an unclosed fence as markdown, since the reply stopped mid-embed", () => {
    const markdown = "Text\n```t3-html\n<div>";
    expect(splitLegacyHtmlEmbedMarkdown(markdown)).toEqual([
      { kind: "markdown", markdown, sourceOffset: 0 },
    ]);
  });

  it("ignores a fence quoted inside another fence", () => {
    const markdown = "````md\n```t3-html\n<p>x</p>\n```\n````\n";
    expect(splitLegacyHtmlEmbedMarkdown(markdown)).toEqual([
      { kind: "markdown", markdown, sourceOffset: 0 },
    ]);
  });

  it("leaves indented and empty fences as code", () => {
    const markdown = "- item\n  ```t3-html\n  <p>x</p>\n  ```\n\n```t3-html\n\n```\n";
    expect(splitLegacyHtmlEmbedMarkdown(markdown)).toEqual([
      { kind: "markdown", markdown, sourceOffset: 0 },
    ]);
  });

  it("only closes on a bare fence of the same character", () => {
    const markdown = "```t3-html\n~~~\n```js\n<p>x</p>\n```\r\nrest";
    expect(splitLegacyHtmlEmbedMarkdown(markdown)).toEqual([
      { kind: "html-embed", html: "~~~\n```js\n<p>x</p>", sourceOffset: 0 },
      { kind: "markdown", markdown: "rest", sourceOffset: 35 },
    ]);
  });
});
