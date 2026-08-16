import { describe, expect, it } from "@effect/vitest";

import {
  hasDeployChanges,
  missingRelayPublicConfigFields,
  publicConfigFromOutput,
  reconcileRootEnvPublicConfig,
  RelayDeployError,
  RelayDeployPublicConfigUnavailableError,
  serializeGithubOutput,
  serializeRelayClientTracingEnvironment,
} from "./deploy.ts";

describe("RelayDeployError", () => {
  it("reports the incomplete state source, stage, and missing fields", () => {
    const missingFields = missingRelayPublicConfigFields({});
    const error = new RelayDeployError({
      source: "alchemy_state",
      stage: "production",
      missingFields,
    });

    expect(error).toMatchObject({
      source: "alchemy_state",
      stage: "production",
      missingFields: ["url"],
    });
    expect(error.message).toBe(
      "Relay deploy output from 'alchemy_state' for stage 'production' is missing required public config fields: url",
    );
  });

  it("distinguishes deploy results that do not produce public config", () => {
    const error = new RelayDeployPublicConfigUnavailableError({
      result: "dry-run",
      stage: "production",
      outputPath: "/tmp/relay-client.env",
    });

    expect(error.message).toBe(
      "Relay deploy result 'dry-run' for stage 'production' did not produce public config required by GitHub environment output '/tmp/relay-client.env'.",
    );
  });
});

describe("hasDeployChanges", () => {
  it("detects resource, binding, and deletion changes", () => {
    expect(hasDeployChanges({ resources: {}, deletions: {} } as never)).toBe(false);
    expect(
      hasDeployChanges({
        resources: {
          api: { action: "create", bindings: [] },
        },
        deletions: {},
      } as never),
    ).toBe(true);
    expect(
      hasDeployChanges({
        resources: {
          api: { action: "noop", bindings: [{ action: "update" }] },
        },
        deletions: {},
      } as never),
    ).toBe(true);
    expect(
      hasDeployChanges({
        resources: {},
        deletions: {
          api: { action: "delete", bindings: [] },
        },
      } as never),
    ).toBe(true);
  });
});

describe("reconcileRootEnvPublicConfig", () => {
  const config = {
    relayUrl: "https://relay.example.test",
  } as const;

  it("adds the relay URL without tracing configuration", () => {
    expect(reconcileRootEnvPublicConfig("", config)).toBe(
      "T3CODE_RELAY_URL=https://relay.example.test\n",
    );
  });

  it("removes stale tracing values while preserving unrelated entries", () => {
    expect(
      reconcileRootEnvPublicConfig(
        [
          "T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_example",
          "T3CODE_RELAY_URL=https://old.example.test",
          "T3CODE_MOBILE_OTLP_TRACES_URL=https://old.example.test/v1/traces",
          "T3CODE_MOBILE_OTLP_TRACES_DATASET=old-dataset",
          "T3CODE_MOBILE_OTLP_TRACES_TOKEN=old-token",
          "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL=https://old.example.test/v1/traces",
          "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET=old-client-dataset",
          "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN=old-client-token",
          "",
        ].join("\n"),
        config,
      ),
    ).toBe(
      [
        "T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_example",
        "T3CODE_RELAY_URL=https://relay.example.test",
        "",
      ].join("\n"),
    );
  });
});

describe("serializeGithubOutput", () => {
  it("serializes relay deploy metadata for GitHub Actions outputs", () => {
    expect(
      serializeGithubOutput({
        changed: false,
        result: "noop",
        relay_url: "https://relay.example.test",
      }),
    ).toBe("changed=false\nresult=noop\nrelay_url=https://relay.example.test\n");
  });
});

describe("serializeRelayClientTracingEnvironment", () => {
  it("writes an empty compatibility artifact when tracing is disabled", () => {
    expect(
      serializeRelayClientTracingEnvironment({
        relayUrl: "https://relay.example.test",
      }),
    ).toBe("");
  });
});

describe("publicConfigFromOutput", () => {
  it("reads the relay URL without tracing output", () => {
    expect(publicConfigFromOutput({ url: "https://relay.example.test" })).toEqual({
      relayUrl: "https://relay.example.test",
    });
  });

  it("rejects incomplete stack output", () => {
    expect(publicConfigFromOutput({})).toBeNull();
  });
});
