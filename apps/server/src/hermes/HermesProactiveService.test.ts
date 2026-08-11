import {
  ProviderInstanceConfigMap,
  type HermesGatewayCompatibility,
  type HermesGatewayCronListResult,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as ServerSettings from "../serverSettings.ts";
import { layer as proactiveRepositoryLayer } from "./HermesProactiveEventRepository.ts";
import type { HermesProactiveInboxShape, HermesWitnessedRun } from "./HermesProactiveInbox.ts";
import { hermesCronJobIsEnabled, hermesCronJobSessionKey, make } from "./HermesProactiveService.ts";
import {
  HermesSessionBindingRepository,
  layer as bindingRepositoryLayer,
} from "./HermesSessionBindingRepository.ts";

const decodeProviderInstanceConfigMap = Schema.decodeUnknownSync(ProviderInstanceConfigMap);

const legacyCompatibility: HermesGatewayCompatibility = {
  status: "legacy",
  protocol: null,
  capabilities: ["cron.read", "cron.manage"],
  inventory: null,
  reason: "Pinned gateway does not advertise protocol capabilities.",
};

const advertisingCompatibility: HermesGatewayCompatibility = {
  status: "supported",
  protocol: {
    major: 1,
    minor: 1,
    capabilities: ["cron.events.global_cursor", "events.stable_ids"],
  },
  capabilities: ["cron.read", "cron.events.global_cursor", "events.stable_ids"],
  inventory: ["cron.events.global_cursor", "events.stable_ids"],
  reason: "supported",
};

const PROVIDER_INSTANCE_ID = "hermes_main";
const PROFILE_KEY = "work";

function settingsLayer(proactiveEnabled: boolean) {
  return ServerSettings.layerTest({
    enableHermes: true,
    providerInstances: decodeProviderInstanceConfigMap({
      [PROVIDER_INSTANCE_ID]: {
        driver: "hermes",
        displayName: "Hermes",
        enabled: true,
        environment: [{ name: "HERMES_GATEWAY_TOKEN", value: "token-1", sensitive: true }],
        config: {
          enabled: true,
          endpoint: "ws://127.0.0.1:9119/api/ws",
          profileKey: PROFILE_KEY,
          proactiveEnabled,
        },
      },
    }),
  });
}

const persistence = NodeSqliteClient.layerMemory();
const repositories = Layer.mergeAll(bindingRepositoryLayer, proactiveRepositoryLayer).pipe(
  Layer.provideMerge(persistence),
);

interface FakeGateway {
  readonly compatibility?: HermesGatewayCompatibility;
  readonly capabilities?: ReadonlyArray<string>;
  readonly jobs?: HermesGatewayCronListResult["jobs"];
  readonly connectFails?: boolean;
}

function fakeClientFactory(gateway: FakeGateway) {
  const capabilities = new Set(gateway.capabilities ?? ["cron.read"]);
  return () => ({
    connect: () =>
      gateway.connectFails === true
        ? Promise.reject(new Error("gateway unreachable"))
        : Promise.resolve(gateway.compatibility ?? legacyCompatibility),
    hasCapability: (capability: string) => capabilities.has(capability),
    listCronJobs: () => Promise.resolve({ success: true, jobs: gateway.jobs ?? [] }),
    close: () => {},
  });
}

const seedBinding = Effect.fn("seedBinding")(function* (input: {
  readonly threadId: string;
  readonly storedSessionKey: string;
}) {
  const repository = yield* HermesSessionBindingRepository;
  yield* repository.createBinding({
    bindingId: `binding:${input.storedSessionKey}`,
    providerInstanceId: PROVIDER_INSTANCE_ID,
    profileKey: PROFILE_KEY,
    projectId: "project:test",
    storedSessionKey: input.storedSessionKey,
    threadId: input.threadId,
    protocolClassification: "legacy",
    protocolMajor: null,
    protocolMinor: null,
    capabilities: [],
    reconciliationCursor: null,
    reconciliationFingerprint: null,
    now: "2026-07-25T12:00:00.000Z",
  });
});

describe("hermesCronJobSessionKey", () => {
  it("prefers the durable session key over the ephemeral live id", () => {
    assert.equal(
      hermesCronJobSessionKey({ session_key: "stored-1", session_id: "live-9" }),
      "stored-1",
    );
    assert.equal(hermesCronJobSessionKey({ session_id: "live-9" }), "live-9");
    assert.equal(hermesCronJobSessionKey({ session_id: "  " }), null);
    assert.equal(hermesCronJobSessionKey({}), null);
  });
});

describe("hermesCronJobIsEnabled", () => {
  it("reads enabled, then paused, and treats a silent gateway as live", () => {
    assert.isTrue(hermesCronJobIsEnabled({ enabled: true }));
    assert.isFalse(hermesCronJobIsEnabled({ enabled: false }));
    assert.isFalse(hermesCronJobIsEnabled({ paused: true }));
    assert.isTrue(hermesCronJobIsEnabled({ paused: false }));
    assert.isTrue(hermesCronJobIsEnabled({}));
  });
});

describe("HermesProactiveService", () => {
  const runSweep = (input: {
    readonly proactiveEnabled: boolean;
    readonly gateway: FakeGateway;
    readonly seed?: ReadonlyArray<{ readonly threadId: string; readonly storedSessionKey: string }>;
    readonly resident?: Array<string>;
  }) =>
    Effect.gen(function* () {
      yield* runMigrations({});
      for (const binding of input.seed ?? []) {
        yield* seedBinding(binding);
      }
      const service = yield* make({
        clientFactory: fakeClientFactory(input.gateway),
        ensureResident: ({ threadId }) =>
          Effect.sync(() => {
            input.resident?.push(threadId);
            return true;
          }),
      });
      return yield* service.sweep();
    }).pipe(
      Effect.provide(Layer.mergeAll(repositories, settingsLayer(input.proactiveEnabled))),
      Effect.orDie,
    );

  it.effect("leaves an instance alone when proactive mode is off", () =>
    Effect.gen(function* () {
      const resident: Array<string> = [];
      const report = yield* runSweep({
        proactiveEnabled: false,
        gateway: {},
        seed: [{ threadId: "thread:a", storedSessionKey: "stored-a" }],
        resident,
      });
      const provider = report.providers[0];
      assert.equal(report.providers.length, 1);
      assert.isFalse(provider?.enabled);
      assert.deepEqual(resident, []);
      assert.deepEqual(provider?.diagnostics, [
        "Proactive mode is disabled for this Hermes instance.",
      ]);
    }),
  );

  it.effect("reports a gateway it cannot reach without claiming residency", () =>
    Effect.gen(function* () {
      const resident: Array<string> = [];
      const report = yield* runSweep({
        proactiveEnabled: true,
        gateway: { connectFails: true },
        seed: [{ threadId: "thread:a", storedSessionKey: "stored-a" }],
        resident,
      });
      const provider = report.providers[0];
      assert.isTrue(provider?.enabled);
      assert.equal(provider?.source, null);
      assert.deepEqual(resident, []);
      assert.deepEqual(provider?.diagnostics, [
        "Could not reach the Hermes gateway to establish proactive residency.",
      ]);
    }),
  );

  it.effect("records a pinned gateway as degraded and still keeps threads subscribed", () =>
    Effect.gen(function* () {
      const resident: Array<string> = [];
      const report = yield* runSweep({
        proactiveEnabled: true,
        gateway: { jobs: [{ name: "inbox", schedule: "0 * * * *", enabled: true }] },
        seed: [{ threadId: "thread:a", storedSessionKey: "stored-a" }],
        resident,
      });
      const provider = report.providers[0];
      assert.equal(provider?.source?.state, "degraded");
      assert.equal(provider?.source?.diagnosticCode, "missing_capability_inventory");
      assert.equal(provider?.enabledJobCount, 1);
      assert.deepEqual(resident, ["thread:a"]);
      assert.equal(provider?.residentThreads[0]?.selectedBy, "recent");
      assert.isTrue(
        provider?.diagnostics.some((diagnostic) => diagnostic.includes("while T3 was closed")),
      );
      assert.isTrue(
        provider?.diagnostics.some((diagnostic) =>
          diagnostic.includes("do not name their session"),
        ),
      );
    }),
  );

  it.effect("subscribes exactly the thread a job names when the gateway names one", () =>
    Effect.gen(function* () {
      const resident: Array<string> = [];
      const report = yield* runSweep({
        proactiveEnabled: true,
        gateway: {
          compatibility: advertisingCompatibility,
          jobs: [{ name: "inbox", enabled: true, session_key: "stored-b" }],
        },
        seed: [
          { threadId: "thread:a", storedSessionKey: "stored-a" },
          { threadId: "thread:b", storedSessionKey: "stored-b" },
        ],
        resident,
      });
      const provider = report.providers[0];
      assert.equal(provider?.source?.state, "ready");
      assert.deepEqual(resident, ["thread:b"]);
      assert.equal(provider?.residentThreads[0]?.selectedBy, "job");
      assert.isFalse(
        provider?.diagnostics.some((diagnostic) =>
          diagnostic.includes("do not name their session"),
        ),
      );
    }),
  );

  it.effect("keeps nothing subscribed when every scheduled job is paused", () =>
    Effect.gen(function* () {
      const resident: Array<string> = [];
      const report = yield* runSweep({
        proactiveEnabled: true,
        gateway: { jobs: [{ name: "inbox", paused: true }] },
        seed: [{ threadId: "thread:a", storedSessionKey: "stored-a" }],
        resident,
      });
      assert.equal(report.providers[0]?.enabledJobCount, 0);
      assert.deepEqual(resident, []);
    }),
  );

  it.effect("answers the first status read by sweeping instead of returning nothing", () =>
    Effect.gen(function* () {
      yield* runMigrations({});
      const service = yield* make({ clientFactory: fakeClientFactory({}) });
      const report = yield* service.report();
      assert.equal(report.providers.length, 1);
      assert.isNotNull(report.sweptAt);
    }).pipe(Effect.provide(Layer.mergeAll(repositories, settingsLayer(true))), Effect.orDie),
  );

  it.effect("says so when the gateway exposes no cron inventory at all", () =>
    Effect.gen(function* () {
      const report = yield* runSweep({
        proactiveEnabled: true,
        gateway: { capabilities: [] },
      });
      assert.isTrue(
        report.providers[0]?.diagnostics.some((diagnostic) =>
          diagnostic.includes("does not expose cron.read"),
        ),
      );
    }),
  );
});

describe("HermesProactiveService missed runs", () => {
  interface MutableGateway {
    compatibility?: HermesGatewayCompatibility;
    capabilities?: ReadonlyArray<string>;
    jobs?: HermesGatewayCronListResult["jobs"];
  }

  /**
   * Records what the sweep decided to announce. The real inbox is exercised in
   * HermesProactiveInbox.test.ts; here only the decision matters.
   */
  function recordingInbox() {
    const witnessed: Array<HermesWitnessedRun> = [];
    const empty = { notifications: [], unreadCount: 0, deadLetterCount: 0 } as const;
    const inbox: HermesProactiveInboxShape = {
      witness: (run) =>
        Effect.sync(() => {
          witnessed.push(run);
        }),
      snapshot: Effect.succeed(empty),
      subscribe: Effect.succeed({ latest: empty, changes: Stream.never }),
      mark: () => Effect.succeed({ updated: 0, snapshot: empty }),
      drain: Effect.succeed({ delivered: 0, retried: 0, deadLettered: 0 }),
    };
    return { inbox, witnessed };
  }

  /**
   * One database across every sweep in a scenario, which is what makes the
   * watermark from an earlier process visible to a later one.
   */
  const scenarioLayer = Layer.mergeAll(repositories, settingsLayer(true));
  const scenario = <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof scenarioLayer> | Scope.Scope>,
  ): Effect.Effect<A> => effect.pipe(Effect.scoped, Effect.provide(scenarioLayer), Effect.orDie);

  /**
   * A service instance with its own first-sweep memory, which is what
   * distinguishes "this process has looked before" from a fresh server start.
   */
  const sweepWith = Effect.fn("sweepWith")(function* (input: {
    readonly gateway: MutableGateway;
    readonly inbox: HermesProactiveInboxShape;
    readonly resident: boolean;
  }) {
    return yield* make({
      clientFactory: fakeClientFactory(input.gateway),
      ensureResident: () => Effect.succeed(input.resident),
      inbox: input.inbox,
      sweptSources: new Set<string>(),
    });
  });

  it.effect("announces a run that finished while T3 was closed", () =>
    scenario(
      Effect.gen(function* () {
        yield* runMigrations({});
        yield* seedBinding({ threadId: "thread:b", storedSessionKey: "stored-b" });
        const gateway: MutableGateway = {
          jobs: [{ name: "inbox", enabled: true, session_key: "stored-b", last_run_at: "t1" }],
        };
        const first = recordingInbox();

        // The process that was running when the job last ran learns the
        // watermark and says nothing: it has no earlier value to compare to.
        const before = yield* sweepWith({ gateway, inbox: first.inbox, resident: true });
        yield* before.sweep();
        assert.deepEqual(first.witnessed, []);

        // T3 restarts, and by then Hermes has run the job again.
        gateway.jobs = [
          { name: "inbox", enabled: true, session_key: "stored-b", last_run_at: "t2" },
        ];
        const after = recordingInbox();
        const restarted = yield* sweepWith({ gateway, inbox: after.inbox, resident: true });
        const report = yield* restarted.sweep();

        assert.equal(after.witnessed.length, 1);
        assert.equal(after.witnessed[0]?.eventKind, "cron.run.missed");
        assert.equal(after.witnessed[0]?.threadId, "thread:b");
        assert.equal(after.witnessed[0]?.runIdentity, "inbox:t2");
        assert.isTrue(
          report.providers[0]?.diagnostics.some((diagnostic) =>
            diagnostic.includes("without T3 watching"),
          ),
        );
      }),
    ),
  );

  it.effect("stays quiet for a run that arrived live on a subscribed session", () =>
    scenario(
      Effect.gen(function* () {
        yield* runMigrations({});
        yield* seedBinding({ threadId: "thread:b", storedSessionKey: "stored-b" });
        const gateway: MutableGateway = {
          jobs: [{ name: "inbox", enabled: true, session_key: "stored-b", last_run_at: "t1" }],
        };
        const { inbox, witnessed } = recordingInbox();
        const service = yield* sweepWith({ gateway, inbox, resident: true });
        yield* service.sweep();

        // Same process, same subscribed session: the adapter already announced
        // this one as it streamed, so the sweep must not announce it again.
        gateway.jobs = [
          { name: "inbox", enabled: true, session_key: "stored-b", last_run_at: "t2" },
        ];
        yield* service.sweep();
        assert.deepEqual(witnessed, []);
      }),
    ),
  );

  it.effect("announces a run on a session it never managed to subscribe to", () =>
    scenario(
      Effect.gen(function* () {
        yield* runMigrations({});
        yield* seedBinding({ threadId: "thread:b", storedSessionKey: "stored-b" });
        const gateway: MutableGateway = {
          jobs: [{ name: "inbox", enabled: true, session_key: "stored-b", last_run_at: "t1" }],
        };
        const { inbox, witnessed } = recordingInbox();
        const service = yield* sweepWith({ gateway, inbox, resident: false });
        yield* service.sweep();

        gateway.jobs = [
          { name: "inbox", enabled: true, session_key: "stored-b", last_run_at: "t2" },
        ];
        yield* service.sweep();
        assert.equal(witnessed.length, 1);
        assert.equal(witnessed[0]?.runIdentity, "inbox:t2");
      }),
    ),
  );

  it.effect("says nothing about a job it is meeting for the first time", () =>
    scenario(
      Effect.gen(function* () {
        yield* runMigrations({});
        const gateway: MutableGateway = {
          jobs: [{ name: "inbox", enabled: true, last_run_at: "t1" }],
        };
        const { inbox, witnessed } = recordingInbox();
        const service = yield* sweepWith({ gateway, inbox, resident: true });
        yield* service.sweep();
        assert.deepEqual(witnessed, []);
      }),
    ),
  );
});
