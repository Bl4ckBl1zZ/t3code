import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ToolActivitySource, ToolActivityIcon } from "@t3tools/contracts";
import { codexMcpToolPresentation, codexMcpIntentTitle } from "./codexToolPresentation.ts";

const decodeSource = Schema.decodeUnknownSync(ToolActivitySource);
const decodeIcon = Schema.decodeUnknownSync(ToolActivityIcon);
describe("Codex tool source metadata", () => {
  it("prefers the selected screenshot over a browser URL and the latest open tab", () => {
    const result = codexMcpToolPresentation({
      appContext: { appName: "Google Chrome" },
      result: {
        _meta: {
          "codex/toolSurface": {
            kind: "browserUse",
            screenshot: {
              pageUrl: "https://github.com/o/r",
              faviconUrlDark: "https://icons.test/dark.png",
            },
            openTabs: [{ url: "https://other.test" }],
          },
          browser_use: { url: "https://second.test" },
        },
      },
    });
    expect(result).toEqual({
      toolSurface: "browser",
      toolIcon: {
        _tag: "website",
        pageUrl: "https://github.com/o/r",
        faviconUrlDark: "https://icons.test/dark.png",
      },
      toolSource: {
        key: "browser-use:chrome",
        name: "Chrome",
        kind: "integration",
        icon: { _tag: "native-app", app: { _tag: "display-name", displayName: "Google Chrome" } },
      },
    });
    expect(decodeSource(result.toolSource)).toEqual(result.toolSource);
    expect(decodeIcon(result.toolIcon)).toEqual(result.toolIcon);
  });
  it("falls through malformed candidates and excludes non-image data URLs", () => {
    const result = codexMcpToolPresentation({
      result: {
        _meta: {
          "codex/toolSurface": {
            kind: "browserUse",
            screenshot: { pageUrl: "javascript:alert(1)" },
            openTabs: [{ url: "https://valid.test" }, { url: "file:///private" }],
            logoUrl: "data:text/html,no",
            backend: "iab",
          },
        },
      },
    });
    expect(result.toolIcon).toEqual({ _tag: "website", pageUrl: "https://valid.test/" });
    expect(result.toolSource).toEqual({
      key: "browser-use:browser",
      name: "Browser",
      kind: "browser",
    });
  });
  it("preserves app identity and themed logos without exposing host paths", () => {
    const result = codexMcpToolPresentation({
      arguments: { application: "Figma" },
      result: {
        _meta: {
          "codex/toolSurface": {
            kind: "computerUse",
            app: { kind: "appId", appId: "com.figma.Desktop" },
          },
          source: {
            logoUrl: "https://icons.test/light.png",
            logoDarkUrl: "https://icons.test/dark.png",
          },
        },
      },
    });
    expect(result.toolSource).toEqual({
      key: "native-app:com.figma.desktop",
      name: "Figma",
      kind: "computer",
      icon: {
        _tag: "themed-logo",
        logoUrl: "https://icons.test/light.png",
        logoUrlDark: "https://icons.test/dark.png",
      },
    });
    expect(decodeSource(result.toolSource)).toEqual(result.toolSource);
  });
  it("bounds long app keys and rejects malformed metadata", () => {
    const result = codexMcpToolPresentation({
      result: {
        _meta: {
          "codex/toolSurface": {
            kind: "computerUse",
            app: { kind: "appId", appId: "a".repeat(512) },
          },
        },
      },
    });
    expect(result.toolSource?.key.length).toBe(512);
    expect(decodeSource(result.toolSource)).toEqual(result.toolSource);
    expect(codexMcpToolPresentation({ result: [] })).toEqual({});
    expect(
      codexMcpToolPresentation({ result: { _meta: { "codex/toolSurface": { kind: "unknown" } } } }),
    ).toEqual({});
  });
});

describe("Codex intent titles", () => {
  it("uses bounded JS intent instead of code or protocol names", () => {
    expect(
      codexMcpIntentTitle(
        {
          server: "browser",
          tool: "js",
          status: "inProgress",
          arguments: { title: "  Inspect\n the page  " },
        },
        {},
      ),
    ).toBe("Inspect the page");
    const title = codexMcpIntentTitle(
      { server: "browser", tool: "js", status: "completed", arguments: { title: "😀".repeat(90) } },
      {},
    );
    expect(Array.from(title ?? "")).toHaveLength(80);
    expect(title?.endsWith("…")).toBe(true);
  });
  it("names computer actions without calling failures successes", () => {
    const item = {
      server: "computer_use",
      tool: "scroll",
      status: "inProgress",
      arguments: { application: "Figma", direction: "DOWN" },
    };
    expect(codexMcpIntentTitle(item, {})).toBe("Scrolling down in Figma");
    expect(codexMcpIntentTitle({ ...item, status: "completed" }, {})).toBe(
      "Scrolled down in Figma",
    );
    expect(codexMcpIntentTitle({ ...item, status: "failed" }, {})).toBeUndefined();
    expect(codexMcpIntentTitle({ ...item, server: "unrelated" }, {})).toBeUndefined();
  });
});
