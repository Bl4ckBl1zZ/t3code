import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HostResources from "./HostResources.ts";

it.layer(NodeServices.layer)("whole-host resources", (it) => {
  it.effect("counts reclaimable macOS pages once and shares simultaneous reads", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const service = yield* HostResources.make().pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provide(
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
            string: () =>
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.as(
                  "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 5.\nPages purgeable: 999.\n",
                ),
              ),
          }),
        ),
      );
      const [first, second] = yield* Effect.all([service.read, service.read], {
        concurrency: "unbounded",
      });
      assert.equal(first.availableMemoryBytes, 35 * 16384);
      assert.deepEqual(first, second);
      assert.deepEqual(yield* service.read, first);
      assert.equal(yield* Ref.get(calls), 1);
      assert.isAbove(first.cpuCount, 0);
      if (first.cpuUtilization !== null) {
        assert.isAtLeast(first.cpuUtilization, 0);
        assert.isAtMost(first.cpuUtilization, 1);
      }
    }).pipe(TestClock.withLive),
  );
  it.effect("retries immediately after the previous caller is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const calls = yield* Ref.make(0);
      const service = yield* HostResources.make().pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provide(
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
            string: () =>
              Effect.gen(function* () {
                if ((yield* Ref.updateAndGet(calls, (count) => count + 1)) === 1) {
                  yield* Deferred.succeed(started, undefined);
                  return yield* Effect.never;
                }
                return "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 5.\n";
              }),
          }),
        ),
      );
      const first = yield* service.read.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(first);
      assert.equal((yield* service.read).availableMemoryBytes, 35 * 4096);
      assert.equal(yield* Ref.get(calls), 2);
    }).pipe(TestClock.withLive),
  );
});
