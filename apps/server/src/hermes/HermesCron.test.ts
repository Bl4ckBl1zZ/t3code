import {
  HermesCronError,
  ProviderInstanceConfigMap,
  type HermesGatewayCompatibility,
  type HermesGatewayCronListResult,
  type HermesGatewayCronMutationResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import {
  makeHermesCron,
  projectHermesCronCapabilities,
  projectHermesCronJob,
} from "./HermesCron.ts";
import {
  HermesGatewayConfigurationError,
  HermesGatewayDuplicateOperationIdError,
} from "./HermesGatewayClient.ts";

const decodeProviderInstanceConfigMap = Schema.decodeUnknownSync(ProviderInstanceConfigMap);

describe("HermesCron projection", () => {
  it("limits a legacy gateway to the actions it answered a probe for", () => {
    expect(
      projectHermesCronCapabilities(
        {
          status: "legacy",
          protocol: null,
          inventory: null,
          capabilities: ["cron.read", "cron.manage"],
          reason: "legacy",
        },
        // What the shipped Hermes build actually accepts.
        new Set(["list", "add", "pause", "resume", "remove"]),
      ),
    ).toEqual({
      inventory: true,
      create: true,
      edit: false,
      pause: true,
      resume: true,
      delete: true,
      runNow: false,
    });
  });

  it("refuses every mutation when a probe found no usable action", () => {
    expect(
      projectHermesCronCapabilities(
        {
          status: "legacy",
          protocol: null,
          inventory: null,
          capabilities: ["cron.read", "cron.manage"],
          reason: "legacy",
        },
        new Set(["list"]),
      ),
    ).toEqual({
      inventory: true,
      create: false,
      edit: false,
      pause: false,
      resume: false,
      delete: false,
      runNow: false,
    });
  });

  it("keeps cron unavailable when the gateway never answered cron.manage", () => {
    expect(
      projectHermesCronCapabilities(
        { status: "legacy", protocol: null, inventory: null, capabilities: [], reason: "legacy" },
        new Set(),
      ),
    ).toEqual({
      inventory: false,
      create: false,
      edit: false,
      pause: false,
      resume: false,
      delete: false,
      runNow: false,
    });
  });

  it("fails closed for unsupported gateways even when capabilities are advertised", () => {
    expect(
      projectHermesCronCapabilities({
        status: "unsupported",
        protocol: null,
        inventory: {
          "cron.read": "supported",
          "cron.manage": { operations: ["add", "remove", "update", "pause", "resume", "run"] },
        },
        capabilities: ["cron.read", "cron.manage"],
        reason: "unsupported",
      }),
    ).toEqual({
      inventory: false,
      create: false,
      edit: false,
      pause: false,
      resume: false,
      delete: false,
      runNow: false,
    });
  });

  it("enables extension mutations only from advertised granular operations", () => {
    expect(
      projectHermesCronCapabilities({
        status: "supported",
        protocol: { major: 1, minor: 2 },
        inventory: {
          "cron.read": "supported",
          "cron.manage": { operations: ["add", "remove", "update", "pause", "resume", "run"] },
        },
        capabilities: ["cron.read", "cron.manage"],
        reason: "supported",
      }),
    ).toEqual({
      inventory: true,
      create: true,
      edit: true,
      pause: true,
      resume: true,
      delete: true,
      runNow: true,
    });
  });

  it("projects provenance and deterministically deduplicates cron executions", () => {
    const job = projectHermesCronJob(
      "hermes_work",
      "work",
      {
        id: "job-1",
        name: "Daily check",
        schedule: "0 9 * * *",
        prompt: "Check status",
        enabled: true,
        executions: [
          { run_id: "run-1", cursor: 4, status: "complete", started_at: "2026-01-01" },
          { run_id: "run-1", cursor: 4, status: "complete", started_at: "2026-01-01" },
          { status: "failed", started_at: "2026-01-02" },
        ],
      },
      0,
    );

    expect(job.identity).toBe("job-1");
    expect(job.executions).toHaveLength(2);
    expect(job.executions[0]).toMatchObject({
      dedupeKey: "hermes-run:run-1",
      provenance: {
        scheduler: "hermes",
        providerInstanceId: "hermes_work",
        profileKey: "work",
        jobIdentity: "job-1",
        upstreamRunId: "run-1",
        upstreamCursor: 4,
        identityStrength: "upstream",
      },
    });
    expect(job.executions[1]?.dedupeKey).toMatch(/^hermes-derived:/u);
  });

  it("marks jobs without upstream id or name as unaddressable", () => {
    const first = projectHermesCronJob(
      "hermes",
      "default",
      { schedule: "0 0 * * *", prompt: "x" },
      2,
    );
    const second = projectHermesCronJob(
      "hermes",
      "default",
      { schedule: "0 0 * * *", prompt: "x" },
      2,
    );
    expect(first.identityStrength).toBe("missing");
    expect(first.identity).toBe(second.identity);
  });

  it("reads the field names the shipped gateway actually sends", () => {
    const job = projectHermesCronJob(
      "hermes",
      "default",
      {
        job_id: "55e75087381b",
        name: "RestoreCord daily first-touch 50",
        schedule: "every 1440m",
        prompt_preview: "Run the authorized daily campaign",
        enabled: true,
        state: "scheduled",
        workdir: "/Users/dev/Desktop/RestoreCord Emails",
        last_run_at: "2026-08-16T14:49:26.216638+02:00",
        last_status: "error",
        last_error: "RuntimeError: HTTP 429: The usage limit has been reached",
      },
      0,
    );

    expect(job.id).toBe("55e75087381b");
    expect(job.identity).toBe("55e75087381b");
    expect(job.identityStrength).toBe("id");
    expect(job.prompt).toBe("Run the authorized daily campaign");
    expect(job.lastOutcome).toBe("failed");
    expect(job.lastStatus).toBe("error");
    expect(job.lastError).toBe("RuntimeError: HTTP 429: The usage limit has been reached");
    expect(job.state).toBe("scheduled");
    expect(job.workdir).toBe("/Users/dev/Desktop/RestoreCord Emails");
  });

  it("classifies run outcomes without inventing one for a job that never ran", () => {
    const outcome = (last_status: string | null) =>
      projectHermesCronJob("hermes", "default", { name: "j", last_status }, 0).lastOutcome;
    expect(outcome("success")).toBe("succeeded");
    expect(outcome("completed")).toBe("succeeded");
    expect(outcome("error")).toBe("failed");
    expect(outcome("timeout")).toBe("failed");
    expect(outcome("running")).toBe("running");
    expect(outcome(null)).toBe("unknown");
    expect(outcome("something-new")).toBe("unknown");
  });
});

describe("HermesCron mutate", () => {
  const compatibility: HermesGatewayCompatibility = {
    status: "supported",
    protocol: { major: 1, minor: 2 },
    inventory: {
      "cron.read": "supported",
      "cron.manage": { operations: ["add", "remove", "update", "pause", "resume", "run"] },
    },
    capabilities: ["cron.read", "cron.manage"],
    reason: "supported",
  };

  const settingsLayer = ServerSettings.layerTest({
    enableHermes: true,
    providerInstances: decodeProviderInstanceConfigMap({
      hermes_main: {
        driver: "hermes",
        displayName: "Hermes",
        enabled: true,
        environment: [{ name: "HERMES_GATEWAY_TOKEN", value: "token-1", sensitive: true }],
        config: { enabled: true, endpoint: "ws://127.0.0.1:9119/api/ws", profileKey: "work" },
      },
    }),
  });

  const runMutation = (listCronJobs: () => Promise<HermesGatewayCronListResult>) =>
    Effect.gen(function* () {
      const cron = yield* makeHermesCron({
        clientFactory: () => ({
          compatibility,
          connect: () => Promise.resolve(compatibility),
          hasCapability: () => true,
          cronActionInventory: () =>
            Promise.resolve(new Set(["list", "add", "update", "pause", "resume", "remove", "run"])),
          listCronJobs,
          manageCron: () =>
            Promise.resolve({
              success: true,
              job_id: "job-1",
              run_id: "run-1",
            } satisfies HermesGatewayCronMutationResult),
          close: () => {},
        }),
      });
      return yield* cron.mutate({
        providerInstanceId: "hermes_main",
        operation: "create",
        operationId: "op-1",
        name: "Daily check",
        schedule: "0 9 * * *",
        prompt: "Check status",
      });
    }).pipe(Effect.provide(settingsLayer));

  it.effect("returns the confirmed mutation when the follow-up inventory refresh fails", () =>
    Effect.gen(function* () {
      const response = yield* runMutation(() => Promise.reject(new Error("refresh failed")));
      expect(response.upstreamJobId).toBe("job-1");
      expect(response.upstreamRunId).toBe("run-1");
      expect(response.provider.status).toBe("error");
      expect(response.provider.diagnostics).toContain(
        "Cron mutation succeeded, but the follow-up cron inventory refresh failed.",
      );
    }),
  );

  it.effect("projects the refreshed inventory when the follow-up read succeeds", () =>
    Effect.gen(function* () {
      const response = yield* runMutation(() =>
        Promise.resolve({ success: true, jobs: [{ id: "job-1", name: "Daily check" }] }),
      );
      expect(response.upstreamJobId).toBe("job-1");
      expect(response.provider.status).toBe("ready");
      expect(response.provider.jobs.map((job) => job.id)).toEqual(["job-1"]);
    }),
  );

  it.effect("fails the mutation when the gateway reports an unsuccessful result", () =>
    Effect.gen(function* () {
      const cron = yield* makeHermesCron({
        clientFactory: () => ({
          compatibility,
          connect: () => Promise.resolve(compatibility),
          hasCapability: () => true,
          cronActionInventory: () =>
            Promise.resolve(new Set(["list", "add", "update", "pause", "resume", "remove", "run"])),
          listCronJobs: () => Promise.resolve({ success: true, jobs: [] }),
          manageCron: () =>
            Promise.resolve({ success: false } satisfies HermesGatewayCronMutationResult),
          close: () => {},
        }),
      });
      const failure = yield* cron
        .mutate({
          providerInstanceId: "hermes_main",
          operation: "pause",
          operationId: "op-unsuccessful",
          jobIdentity: "job-1",
        })
        .pipe(Effect.flip);
      expect(failure.code).toBe("gateway_error");
      expect(failure.message).toBe("Hermes gateway rejected cron pause.");
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("projects a throwing client factory as a per-provider error in list", () =>
    Effect.gen(function* () {
      const cron = yield* makeHermesCron({
        clientFactory: () => {
          throw new Error("factory blocked");
        },
      });
      const result = yield* cron.list();
      const main = result.providers.find(
        (candidate) => candidate.providerInstanceId === "hermes_main",
      );
      expect(main).toMatchObject({
        status: "error",
        capabilities: { inventory: false, create: false },
        jobs: [],
      });
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("projects an unsuccessful cron inventory response as a provider error", () =>
    Effect.gen(function* () {
      const cron = yield* makeHermesCron({
        clientFactory: () => ({
          compatibility,
          connect: () => Promise.resolve(compatibility),
          hasCapability: () => true,
          cronActionInventory: () =>
            Promise.resolve(new Set(["list", "add", "update", "pause", "resume", "remove", "run"])),
          listCronJobs: () =>
            Promise.resolve({ success: false, jobs: [] } satisfies HermesGatewayCronListResult),
          manageCron: () => Promise.reject(new Error("unused")),
          close: () => {},
        }),
      });
      const result = yield* cron.list();
      const main = result.providers.find(
        (candidate) => candidate.providerInstanceId === "hermes_main",
      );
      expect(main).toMatchObject({ status: "error", jobs: [] });
      expect(main?.diagnostics).toContain(
        "Hermes gateway reported an unsuccessful cron inventory response.",
      );
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("reuses one gateway client so a repeated operation id cannot replay", () =>
    Effect.gen(function* () {
      let factoryCalls = 0;
      let executedMutations = 0;
      const usedOperationIds = new Set<string>();
      const cron = yield* makeHermesCron({
        clientFactory: () => {
          factoryCalls += 1;
          return {
            compatibility,
            connect: () => Promise.resolve(compatibility),
            hasCapability: () => true,
            cronActionInventory: () =>
              Promise.resolve(
                new Set(["list", "add", "update", "pause", "resume", "remove", "run"]),
              ),
            listCronJobs: () =>
              Promise.resolve({ success: true, jobs: [] } satisfies HermesGatewayCronListResult),
            manageCron: (_params, options) => {
              if (usedOperationIds.has(options.operationId)) {
                return Promise.reject(
                  new HermesGatewayDuplicateOperationIdError(
                    `Hermes mutation operationId has already been used: ${options.operationId}`,
                  ),
                );
              }
              usedOperationIds.add(options.operationId);
              executedMutations += 1;
              return Promise.resolve({
                success: true,
                job_id: "job-1",
              } satisfies HermesGatewayCronMutationResult);
            },
            close: () => {},
          };
        },
      });
      const input = {
        providerInstanceId: "hermes_main",
        operation: "run_now",
        operationId: "op-repeated",
        jobIdentity: "job-1",
      } as const;
      const first = yield* cron.mutate(input);
      expect(first.upstreamJobId).toBe("job-1");
      const failure = yield* cron.mutate(input).pipe(Effect.flip);
      expect(failure.code).toBe("invalid_input");
      expect(factoryCalls).toBe(1);
      expect(executedMutations).toBe(1);
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("closes and evicts the stale client when the connection identity changes", () =>
    Effect.gen(function* () {
      let factoryCalls = 0;
      const closedTokens: Array<string> = [];
      const cron = yield* makeHermesCron({
        clientFactory: ({ authToken }) => {
          factoryCalls += 1;
          return {
            compatibility,
            connect: () => Promise.resolve(compatibility),
            hasCapability: () => true,
            cronActionInventory: () =>
              Promise.resolve(
                new Set(["list", "add", "update", "pause", "resume", "remove", "run"]),
              ),
            listCronJobs: () =>
              Promise.resolve({ success: true, jobs: [] } satisfies HermesGatewayCronListResult),
            manageCron: () =>
              Promise.resolve({
                success: true,
                job_id: "job-1",
              } satisfies HermesGatewayCronMutationResult),
            close: () => {
              closedTokens.push(authToken);
            },
          };
        },
      });
      const input = (operationId: string) =>
        ({
          providerInstanceId: "hermes_main",
          operation: "run_now",
          operationId,
          jobIdentity: "job-1",
        }) as const;
      yield* cron.mutate(input("op-a"));
      expect(factoryCalls).toBe(1);
      expect(closedTokens).toEqual([]);

      const settingsService = yield* ServerSettings.ServerSettingsService;
      yield* settingsService.updateSettings({
        providerInstances: decodeProviderInstanceConfigMap({
          hermes_main: {
            driver: "hermes",
            displayName: "Hermes",
            enabled: true,
            environment: [{ name: "HERMES_GATEWAY_TOKEN", value: "token-2", sensitive: true }],
            config: { enabled: true, endpoint: "ws://127.0.0.1:9119/api/ws", profileKey: "work" },
          },
        }),
      });
      yield* cron.mutate(input("op-b"));
      expect(factoryCalls).toBe(2);
      expect(closedTokens).toEqual(["token-1"]);
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("maps non-duplicate configuration errors to a gateway diagnostic", () =>
    Effect.gen(function* () {
      const cron = yield* makeHermesCron({
        clientFactory: () => ({
          compatibility,
          connect: () => Promise.resolve(compatibility),
          hasCapability: () => true,
          cronActionInventory: () =>
            Promise.resolve(new Set(["list", "add", "update", "pause", "resume", "remove", "run"])),
          listCronJobs: () =>
            Promise.resolve({ success: true, jobs: [] } satisfies HermesGatewayCronListResult),
          manageCron: () =>
            Promise.reject(
              new HermesGatewayConfigurationError("Hermes remote access is not paired."),
            ),
          close: () => {},
        }),
      });
      const failure = yield* cron
        .mutate({
          providerInstanceId: "hermes_main",
          operation: "run_now",
          operationId: "op-config",
          jobIdentity: "job-1",
        })
        .pipe(Effect.flip);
      expect(failure.code).toBe("gateway_error");
      expect(failure.message).toContain("Hermes remote access is not paired.");
      expect(failure.message).not.toContain("already used");
    }).pipe(Effect.provide(settingsLayer)),
  );

  it.effect("maps a throwing client factory to a typed error in mutate", () =>
    Effect.gen(function* () {
      const cron = yield* makeHermesCron({
        clientFactory: () => {
          throw new Error("factory blocked");
        },
      });
      const failure = yield* cron
        .mutate({
          providerInstanceId: "hermes_main",
          operation: "create",
          operationId: "op-1",
          name: "Daily check",
          schedule: "0 9 * * *",
          prompt: "Check status",
        })
        .pipe(Effect.flip);
      expect(failure).toBeInstanceOf(HermesCronError);
      expect(failure.code).toBe("gateway_error");
    }).pipe(Effect.provide(settingsLayer)),
  );
});
