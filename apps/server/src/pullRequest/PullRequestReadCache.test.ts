import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PullRequestOperationError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import * as Persistence from "effect/unstable/persistence/Persistence";
import { layerTest as serverConfigLayerTest, ServerConfig } from "../config.ts";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";

const cacheLayer = (directory: string) =>
  PullRequestReadCache.make.pipe(
    Effect.provide(
      Persistence.layerKvs.pipe(Layer.provideMerge(KeyValueStore.layerFileSystem(directory))),
    ),
  );

/** Sets every file's mtime to `age` before the current test clock time. */
const ageFiles = (directory: string, names: ReadonlyArray<string>, age: Duration.Duration) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mtime = DateTime.toDateUtc(DateTime.subtractDuration(yield* DateTime.now, age));
    for (const name of names) yield* fs.utimes(path.join(directory, name), mtime, mtime);
  });

it.layer(NodeServices.layer)("PR filesystem cache", (it) => {
  it.effect("prunes entry files written before the max age and keeps fresh ones", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-cache-" });
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-01T00:00:00Z")));
      const cache = yield* cacheLayer(directory);
      yield* cache.get("old", Effect.succeed("old"));
      const [stale] = yield* fs.readDirectory(directory);
      yield* cache.get("fresh", Effect.succeed("fresh"));
      const fresh = (yield* fs.readDirectory(directory)).find((name) => name !== stale);
      const unrelated = "unrelated.json";
      yield* fs.writeFileString(`${directory}/${unrelated}`, "{}");
      const justExpired = Duration.sum(
        PullRequestReadCache.ENTRY_FILE_MAX_AGE,
        Duration.seconds(1),
      );
      yield* ageFiles(directory, [stale!, unrelated], justExpired);
      yield* ageFiles(directory, [fresh!], PullRequestReadCache.ENTRY_FILE_MAX_AGE);

      yield* PullRequestReadCache.pruneExpiredEntryFiles(directory);

      assert.deepStrictEqual(
        (yield* fs.readDirectory(directory)).toSorted(),
        [fresh!, unrelated].toSorted(),
      );
    }),
  );

  it.effect("sweeps the cache directory every hour once the layer is built", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { providerStatusCacheDir } = yield* ServerConfig;
      const directory = `${providerStatusCacheDir}/pull-requests`;
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-01T00:00:00Z")));
      yield* (yield* cacheLayer(directory)).get("summary", Effect.succeed("cached"));
      const [entry] = yield* fs.readDirectory(directory);
      // Within the max age at the first two sweeps, past it at the third.
      yield* ageFiles(
        directory,
        [entry!],
        Duration.subtract(PullRequestReadCache.ENTRY_FILE_MAX_AGE, Duration.minutes(90)),
      );
      // A sweep's last file operation is the entry's stat when it keeps the
      // entry, and its removal otherwise. Waiting for it means the sweep has
      // finished before the clock moves.
      const operations = yield* Queue.unbounded<string>();
      const observedFs = FileSystem.FileSystem.of({
        ...fs,
        stat: (path) => fs.stat(path).pipe(Effect.tap(() => Queue.offer(operations, "stat"))),
        remove: (path, options) =>
          fs.remove(path, options).pipe(Effect.tap(() => Queue.offer(operations, "remove"))),
      });
      yield* Layer.build(
        PullRequestReadCache.layer.pipe(
          Layer.provide(Layer.succeed(FileSystem.FileSystem, observedFs)),
        ),
      );
      assert.strictEqual(yield* Queue.take(operations), "stat");
      yield* TestClock.adjust("1 hour");
      assert.strictEqual(yield* Queue.take(operations), "stat");
      assert.deepStrictEqual(yield* fs.readDirectory(directory), [entry]);
      yield* TestClock.adjust("1 hour");
      assert.strictEqual(yield* Queue.take(operations), "stat");
      assert.strictEqual(yield* Queue.take(operations), "remove");
      assert.deepStrictEqual(yield* fs.readDirectory(directory), []);
    }).pipe(
      Effect.scoped,
      Effect.provide(serverConfigLayerTest(process.cwd(), { prefix: "t3-pr-cache-layer-" })),
    ),
  );

  it.effect("reuses files after restart and respects the original expiry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-cache-" });
      let reads = 0;
      const lookup = Effect.sync(() => String(++reads));
      const first = yield* cacheLayer(directory);
      const key = "long/repository/key".repeat(100);
      assert.strictEqual(yield* first.get(key, lookup), "1");
      yield* TestClock.adjust("59 seconds");
      const restarted = yield* cacheLayer(directory);
      assert.strictEqual(yield* restarted.get(key, lookup), "1");
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* restarted.get(key, lookup), "2");
      assert.strictEqual(reads, 2);
      assert.strictEqual((yield* fs.readDirectory(directory)).length, 1);
    }),
  );

  it.effect("clears in-flight reads before a new service can reuse them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-cache-" });
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const cache = yield* cacheLayer(directory);
      const read = yield* cache
        .get(
          "summary",
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as("old"),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const invalidate = yield* cache.invalidate.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(read);
      yield* Fiber.join(invalidate);
      const restarted = yield* cacheLayer(directory);
      assert.strictEqual(yield* restarted.get("summary", Effect.succeed("new")), "new");
    }),
  );

  it.effect("does not persist failed GitHub reads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-cache-" });
      const cache = yield* cacheLayer(directory);
      const error = new PullRequestOperationError({ operation: "summary", detail: "unavailable" });
      yield* cache.get("summary", Effect.fail(error)).pipe(Effect.flip);
      const restarted = yield* cacheLayer(directory);
      assert.strictEqual(yield* restarted.get("summary", Effect.succeed("recovered")), "recovered");
    }),
  );
  it.effect("keeps the shorter detail expiry after a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-detail-cache-" });
      let reads = 0;
      const lookup = Effect.sync(() => String(++reads));
      const first = yield* cacheLayer(directory);
      assert.strictEqual(yield* first.get("detail", lookup, 15_000), "1");
      yield* TestClock.adjust("14 seconds");
      const restarted = yield* cacheLayer(directory);
      assert.strictEqual(yield* restarted.get("detail", lookup, 15_000), "1");
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* restarted.get("detail", lookup, 15_000), "2");
    }),
  );
  it.effect("falls back to a host read when the persisted file is corrupt", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-corrupt-cache-" });
      const cache = yield* cacheLayer(directory);
      yield* cache.get("detail", Effect.succeed("old"));
      for (const file of yield* fs.readDirectory(directory)) {
        yield* fs.writeFileString(`${directory}/${file}`, "not valid cache data");
      }
      const restarted = yield* cacheLayer(directory);
      assert.strictEqual(yield* restarted.get("detail", Effect.succeed("fresh")), "fresh");
    }),
  );
});
