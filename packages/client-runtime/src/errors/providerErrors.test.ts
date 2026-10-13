import { describe, expect, it } from "vite-plus/test";

import { presentProviderError } from "./providerErrors.ts";

describe("presentProviderError", () => {
  it("presents protocol failures as a next step without adapter jargon", () => {
    expect(
      presentProviderError(
        "ProviderAdapterProtocolError: opencode provider protocol error: Server closed the connection.",
      ),
    ).toBe(
      "OpenCode couldn't complete the request: Server closed the connection. Check the provider connection in Settings → Providers, then try again.",
    );
  });

  it("removes internal run and provider-thread ids from turn-start failures", () => {
    expect(
      presentProviderError(
        "Failed to start run run-secret on codex provider thread provider-thread-secret.",
      ),
    ).toBe(
      "Codex couldn't start this message. Check the provider connection in Settings → Providers, then try again.",
    );
  });

  it("capitalizes drivers without a display name", () => {
    expect(presentProviderError("acme provider protocol error: Bad frame.")).toBe(
      "Acme couldn't complete the request: Bad frame. Check the provider connection in Settings → Providers, then try again.",
    );
  });

  it("leaves other errors unchanged", () => {
    expect(presentProviderError("  Could not connect to the provider.  ")).toBe(
      "Could not connect to the provider.",
    );
  });
});
