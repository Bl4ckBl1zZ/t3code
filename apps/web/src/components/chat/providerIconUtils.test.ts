import { ProviderDriverKind } from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { HermesIcon, OpenClawIcon } from "../Icons";
import {
  getDisplayModelName,
  getProviderRowLabel,
  PROVIDER_ICON_BY_PROVIDER,
} from "./providerIconUtils";

describe("provider icon mapping", () => {
  it("uses the official Hermes Agent icon for Hermes surfaces", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("hermes")]).toBe(HermesIcon);
    expect(renderToStaticMarkup(createElement(HermesIcon))).toContain(
      'href="/hermes-agent-logo.png"',
    );
  });

  it("uses the OpenClaw icon for OpenClaw surfaces", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("openclaw")]).toBe(OpenClawIcon);
    const markup = renderToStaticMarkup(createElement(OpenClawIcon));
    expect(markup).toContain('viewBox="0 0 120 120"');
    expect(markup).toContain("openclaw__lobster-gradient");
    expect(markup).toContain("#00e5cc");
  });
});

describe("getProviderRowLabel", () => {
  it("shows a sub-provider named after its provider on its own", () => {
    expect(getProviderRowLabel("OpenCode", "OpenCode Zen")).toBe("OpenCode Zen");
    expect(getProviderRowLabel("OpenCode", "OpenCode Go")).toBe("OpenCode Go");
  });

  it("keeps a provider id that merely starts like the provider name", () => {
    expect(getProviderRowLabel("OpenCode", "opencode-go")).toBe("OpenCode · opencode-go");
  });

  it("joins a sub-provider that names something else", () => {
    expect(getProviderRowLabel("OpenCode", "GitHub Copilot")).toBe("OpenCode · GitHub Copilot");
  });

  it("keeps the provider name when a model has no sub-provider", () => {
    expect(getProviderRowLabel("Claude", undefined)).toBe("Claude");
  });
});

describe("getDisplayModelName", () => {
  it("drops a leading sub-provider qualifier from the model name", () => {
    expect(
      getDisplayModelName({
        slug: "a/b",
        name: "OpenCode Zen: Step 5",
        subProvider: "OpenCode Zen",
      }),
    ).toBe("Step 5");
  });
});
