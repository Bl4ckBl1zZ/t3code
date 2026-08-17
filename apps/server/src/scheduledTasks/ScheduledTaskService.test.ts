import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ScheduledTaskService, layer as scheduledTaskLayer } from "./ScheduledTaskService.ts";

const projectId = ProjectId.make("project:automations");
const boundThreadId = ThreadId.make("thread:bound");
const otherThreadId = ThreadId.make("thread:other");

const taskInput = (input: {
  readonly title: string;
  readonly threadId: ThreadId | null;
}): ScheduledTaskUpsertInput => ({
  title: input.title,
  prompt: "Sweep the PRs",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId,
  threadId: input.threadId,
  workspaceStrategy: { type: "root" },
  modelSelection: {
    instanceId: ProviderInstanceId.make("hermes"),
    model: "hermes-1",
  },
  runtimeMode: "approval-required",
  interactionMode: "default",
});

/**
 * Drives the service's thread-deletion watch. `liveThreadIds` is what the
 * startup sweep sees, so a test can start the service with a task already
 * pointing at a thread the projection no longer knows.
 */
const makeTestLayer = (input: {
  readonly events: PubSub.PubSub<OrchestrationV2DomainEvent>;
  readonly liveThreadIds: ReadonlySet<string>;
}) =>
  scheduledTaskLayer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagementService)({
        streamDomainEvents: Stream.fromPubSub(input.events),
        getThreadShell: (threadId) =>
          Effect.succeed(
            input.liveThreadIds.has(String(threadId))
              ? ({ deletedAt: null } as never)
              : ({ deletedAt: "2026-08-17T00:00:00.000Z" } as never),
          ),
      }),
    ),
    Layer.provide(Layer.mock(ThreadLaunchService)({})),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "scheduled-task-test-" })),
    Layer.provide(NodeServices.layer),
  );

const titlesFor = (service: ScheduledTaskService["Service"]) =>
  service.list().pipe(Effect.map((result) => result.tasks.map((task) => task.title).toSorted()));

it.effect("deletes automations bound to a thread when that thread is deleted", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService;
      yield* service.upsert(taskInput({ title: "Bound", threadId: boundThreadId }));
      yield* service.upsert(taskInput({ title: "Other thread", threadId: otherThreadId }));
      yield* service.upsert(taskInput({ title: "Unbound", threadId: null }));
      assert.deepStrictEqual(yield* titlesFor(service), ["Bound", "Other thread", "Unbound"]);

      // The list subscription is the client's only signal, so the cascade has
      // to re-emit — waiting on it also removes the need to poll for the
      // delete to land.
      const changes = yield* Stream.toQueue(service.subscribeList(), { capacity: 8 });
      yield* Queue.take(changes);

      yield* PubSub.publish(events, {
        type: "thread.deleted",
        threadId: boundThreadId,
      } as never);

      yield* Queue.take(changes);
      // Only the thread that was deleted loses its automation; a task bound to
      // a different thread and an unbound task both survive.
      assert.deepStrictEqual(yield* titlesFor(service), ["Other thread", "Unbound"]);
    }).pipe(
      Effect.provide(
        makeTestLayer({
          events,
          liveThreadIds: new Set([String(boundThreadId), String(otherThreadId)]),
        }),
      ),
    );
  }),
);

it.effect("sweeps automations whose thread was deleted while the server was down", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
    // One database, two service lifetimes: the first seeds the rows, the
    // second starts up with the bound thread already missing from the
    // projection, which is what a delete during downtime leaves behind.
    const persistence = SqlitePersistenceMemory.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "scheduled-task-sweep-" })),
      Layer.provide(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const sharedDatabase = Layer.merge(
        Layer.succeedContext(yield* Layer.build(persistence)),
        NodeServices.layer,
      );
      // Deleting a thread is a soft delete: the projection keeps returning a
      // shell, with `deletedAt` set. Mocking this as `null` would pass against
      // a sweep that only checks for a missing shell and never reaps anything
      // in production.
      const serviceOverDatabase = (threadDeletedAt: string | null) =>
        scheduledTaskLayer.pipe(
          Layer.provide(
            Layer.mock(ThreadManagementService)({
              streamDomainEvents: Stream.fromPubSub(events),
              getThreadShell: () => Effect.succeed({ deletedAt: threadDeletedAt } as never),
            }),
          ),
          Layer.provide(Layer.mock(ThreadLaunchService)({})),
          Layer.provide(sharedDatabase),
        );

      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService;
        yield* service.upsert(taskInput({ title: "Bound", threadId: boundThreadId }));
        yield* service.upsert(taskInput({ title: "Unbound", threadId: null }));
        assert.deepStrictEqual(yield* titlesFor(service), ["Bound", "Unbound"]);
      }).pipe(Effect.provide(serviceOverDatabase(null)));

      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService;
        assert.deepStrictEqual(yield* titlesFor(service), ["Unbound"]);
      }).pipe(Effect.provide(serviceOverDatabase("2026-08-17T00:00:00.000Z")));
    }).pipe(Effect.scoped);
  }),
);
