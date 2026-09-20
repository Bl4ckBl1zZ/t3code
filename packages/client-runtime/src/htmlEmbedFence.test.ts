import { describe, expect, it } from "vite-plus/test";

import { findOpenHtmlEmbedFence, htmlEmbedPhase } from "./htmlEmbedFence.ts";

describe("findOpenHtmlEmbedFence", () => {
  it("reports the fence that is still being written", () => {
    const markdown = 'Here it is:\n\n```t3-html\n<style>.a{color:red}</style>\n<div class="a">';
    expect(findOpenHtmlEmbedFence(markdown)).toEqual({
      start: 13,
      marker: 13,
      body: '<style>.a{color:red}</style>\n<div class="a">',
    });
  });

  it("opens the moment the fence line lands, before any body", () => {
    expect(findOpenHtmlEmbedFence("Here:\n\n```t3-html")).toEqual({
      start: 7,
      marker: 7,
      body: "",
    });
  });

  it("ignores a fence that closed", () => {
    expect(findOpenHtmlEmbedFence("```t3-html\n<p>done</p>\n```\n\nand then some text")).toBeNull();
  });

  it("only opens on the embed language", () => {
    expect(findOpenHtmlEmbedFence("```html\n<p>source</p>")).toBeNull();
    expect(findOpenHtmlEmbedFence("```ts\nconst a = 1;")).toBeNull();
  });

  it("keeps the earlier closed embed out of the match", () => {
    const markdown = "```t3-html\n<p>one</p>\n```\n\n```t3-html\n<p>two";
    expect(findOpenHtmlEmbedFence(markdown)?.body).toBe("<p>two");
  });

  it("separates the indent from the marker so either offset matches", () => {
    const fence = findOpenHtmlEmbedFence("intro\n\n  ```t3-html\n<p>x</p>");
    expect(fence).toEqual({ start: 7, marker: 9, body: "<p>x</p>" });
  });

  it("closes on a longer fence and on tildes", () => {
    expect(findOpenHtmlEmbedFence("```t3-html\n<p>a</p>\n`````")).toBeNull();
    expect(findOpenHtmlEmbedFence("~~~t3-html\n<p>a</p>\n~~~")).toBeNull();
    // A shorter run does not close the block, so the fence is still open.
    expect(findOpenHtmlEmbedFence("````t3-html\n<p>a</p>\n```")?.body).toBe("<p>a</p>\n```");
  });

  it("does not open a fence on an inline-code run", () => {
    expect(findOpenHtmlEmbedFence("```t3-html``` is the fence language")).toBeNull();
  });
});

describe("htmlEmbedPhase", () => {
  const openFence = findOpenHtmlEmbedFence("intro\n\n```t3-html\n<p>half");

  it("is ready when nothing is open", () => {
    expect(htmlEmbedPhase({ openFence: null, streaming: true, html: "<p>x</p>" })).toBe("ready");
  });

  it("is ready for a closed embed earlier in a streaming message", () => {
    expect(htmlEmbedPhase({ openFence, streaming: true, offset: 0, html: "<p>done</p>" })).toBe(
      "ready",
    );
  });

  it("builds anywhere on the opening fence line", () => {
    for (const offset of [openFence!.start, openFence!.marker]) {
      expect(htmlEmbedPhase({ openFence, streaming: true, offset, html: "<p>half" })).toBe(
        "building",
      );
    }
  });

  it("matches on body when the parser reports no offset", () => {
    expect(htmlEmbedPhase({ openFence, streaming: true, html: "<p>half\n" })).toBe("building");
    expect(htmlEmbedPhase({ openFence, streaming: true, html: "<p>other</p>" })).toBe("ready");
  });

  it("stops building when the turn ends mid-fence", () => {
    expect(
      htmlEmbedPhase({ openFence, streaming: false, offset: openFence!.marker, html: "<p>half" }),
    ).toBe("incomplete");
  });
});
