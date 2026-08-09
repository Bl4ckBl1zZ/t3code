import { HermesProactiveEventKinds, type HermesGatewayCompatibility } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  HermesProactiveEventRepository,
  layer as repositoryLayer,
} from "./HermesProactiveEventRepository.ts";
import { describeWitnessedRun, make } from "./HermesProactiveInbox.ts";

const PROVIDER_INSTANCE_ID = "hermes_main";
const PROFILE_KEY = "work";
const T0 = "2026-07-25T12:00:00.000Z";

/**
 * The gateway every shipping Hermes build looks like: it can list and manage
 * cron, and it cannot replay anything. Durable ingest refuses to run against
 * it, which is exactly why the witnessed path has to.
 */
const pinnedCompatibility: HermesGatewayCompatibility = {
  status: "legacy",
  protocol: null,
  capabilities: ["cron.read", "cron.manage"],
  inventory: null,
  reason: "Pinned gateway does not advertise protocol capabilities.",
};

const persistence: Layer.Layer<SqlClient.SqlClient, SqlError> = NodeSqliteClient.layerMemory();
const repositories = repositoryLayer.pipe(Layer.provideMerge(persistence));

/**
 * Built per test rather than per file. These assertions are about counts, and a
 * database shared across tests would make each one depend on its neighbours.
 */
const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A> =>
  effect.pipe(Effect.provide(repositories), Effect.orDie) as Effect.Effect<A>;

const witnessedRun = (runIdentity: string) => ({
  providerInstanceId: PROVIDER_INSTANCE_ID,
  profileKey: PROFILE_KEY,
  runIdentity,
  eventKind: HermesProactiveEventKinds.cronRunWitnessed,
  title: "Hermes finished a run you did not start",
  body: "Checked the inbox and sent 50 emails.",
  threadId: "thread:outreach",
  projectId: null,
  occurredAt: T0,
});

const setup = Effect.fn("setup")(function* () {
  yield* runMigrations({});
  const repository = yield* HermesProactiveEventRepository;
  const source = yield* repository.registerSource({
    providerInstanceId: PROVIDER_INSTANCE_ID,
    profileKey: PROFILE_KEY,
    compatibility: pinnedCompatibility,
    now: T0,
  });
  const inbox = yield* make({ deliveryWorker: false });
  return { repository, inbox, source };
});

describe("HermesProactiveInbox", () => {
  it.effect("delivers a witnessed run on a gateway that cannot replay anything", () =>
    scoped(
      Effect.gen(function* () {
        const { inbox, source } = yield* setup();
        assert.strictEqual(source.state, "degraded");

        yield* inbox.witness(witnessedRun("run:1"));
        assert.deepStrictEqual(yield* inbox.drain, {
          delivered: 1,
          retried: 0,
          deadLettered: 0,
        });

        const snapshot = yield* inbox.snapshot;
        assert.strictEqual(snapshot.unreadCount, 1);
        assert.strictEqual(snapshot.deadLetterCount, 0);
        assert.strictEqual(snapshot.notifications[0]?.threadId, "thread:outreach");
        assert.strictEqual(snapshot.notifications[0]?.status, "unread");
      }),
    ),
  );

  it.effect("pings once for a run seen twice", () =>
    scoped(
      Effect.gen(function* () {
        const { inbox } = yield* setup();
        yield* inbox.witness(witnessedRun("run:1"));
        yield* inbox.witness(witnessedRun("run:1"));
        assert.strictEqual((yield* inbox.drain).delivered, 1);

        yield* inbox.witness(witnessedRun("run:2"));
        assert.strictEqual((yield* inbox.drain).delivered, 1);
        assert.strictEqual((yield* inbox.snapshot).unreadCount, 2);
      }),
    ),
  );

  it.effect("leaves the source checkpoint alone when a run is witnessed", () =>
    scoped(
      Effect.gen(function* () {
        const { inbox } = yield* setup();
        yield* inbox.witness(witnessedRun("run:1"));
        yield* inbox.drain;

        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          checkpoint_cursor: string | null;
          checkpoint_sequence: number;
        }>`
          SELECT checkpoint_cursor, checkpoint_sequence FROM hermes_proactive_sources
        `;
        assert.strictEqual(rows[0]?.checkpoint_cursor, null);
        assert.strictEqual(rows[0]?.checkpoint_sequence, 0);
      }),
    ),
  );

  it.effect("moves a notification and its work item together, in both directions", () =>
    scoped(
      Effect.gen(function* () {
        const { repository, inbox } = yield* setup();
        yield* inbox.witness(witnessedRun("run:1"));
        yield* inbox.drain;
        const notificationId = (yield* inbox.snapshot).notifications[0]!.notificationId;

        const read = yield* inbox.mark({ notificationIds: [notificationId], status: "read" });
        assert.strictEqual(read.updated, 1);
        assert.strictEqual(read.snapshot.unreadCount, 0);
        assert.strictEqual((yield* repository.listWorkItems())[0]?.status, "read");

        // Marking the same status again is a no-op rather than a second event.
        assert.strictEqual(
          (yield* inbox.mark({ notificationIds: [notificationId], status: "read" })).updated,
          0,
        );

        const restored = yield* inbox.mark({ notificationIds: [notificationId], status: "unread" });
        assert.strictEqual(restored.updated, 1);
        assert.strictEqual(restored.snapshot.unreadCount, 1);
        assert.strictEqual((yield* repository.listWorkItems())[0]?.status, "unread");
      }),
    ),
  );

  it.effect("drops a run when proactive mode never registered the profile", () =>
    scoped(
      Effect.gen(function* () {
        yield* runMigrations({});
        const inbox = yield* make({ deliveryWorker: false });

        yield* inbox.witness(witnessedRun("run:1"));
        assert.deepStrictEqual(yield* inbox.drain, {
          delivered: 0,
          retried: 0,
          deadLettered: 0,
        });
        assert.strictEqual((yield* inbox.snapshot).unreadCount, 0);
      }),
    ),
  );
});

describe("describeWitnessedRun", () => {
  it("names the job when the gateway gave it one", () => {
    assert.strictEqual(
      describeWitnessedRun({ jobName: "inbox sweep", missed: true }),
      "“inbox sweep” ran while T3 was closed",
    );
    assert.strictEqual(
      describeWitnessedRun({ jobName: null, missed: false }),
      "A scheduled Hermes job finished a run",
    );
  });
});
