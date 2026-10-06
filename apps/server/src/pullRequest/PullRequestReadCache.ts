import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";
import { PullRequestOperationError, PullRequestUnavailableError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import * as Persistable from "effect/unstable/persistence/Persistable";
import * as PersistedCache from "effect/unstable/persistence/PersistedCache";
import * as Persistence from "effect/unstable/persistence/Persistence";
import { ServerConfig } from "../config.ts";
import { forkParked } from "../serverActivation.ts";

const CONCURRENT_READS = 512;
// Persistence prefixes every entry key with the store id, so each entry file
// name starts with it.
const STORE_ID = "pr-v2";
/**
 * Entries expire a minute after they are written, and a write sets the file's
 * mtime. A file untouched for a day is long expired; the day only leaves slack
 * for clock changes. Pruning a live entry would cost one refetch.
 */
export const ENTRY_FILE_MAX_AGE = Duration.days(1);
type ReadError = PullRequestOperationError | PullRequestUnavailableError;

class Read extends Persistable.Class<{
  payload: {
    key: string;
    lookup: Effect.Effect<string, ReadError>;
    ttlMs: number | (() => number);
  };
}>()("PullRequestRead", {
  primaryKey: ({ key }) => key,
  success: Schema.Struct({ payload: Schema.String, expiresAt: Schema.Finite }),
  error: Schema.Union([PullRequestOperationError, PullRequestUnavailableError]),
}) {
  [Equal.symbol](that: unknown): boolean {
    return that instanceof Read && that.key === this.key;
  }
  [Hash.symbol](): number {
    return Hash.string(this.key);
  }
}

export class PullRequestReadCache extends Context.Service<
  PullRequestReadCache,
  {
    /** A `ttlMs` function is asked once the lookup has answered, so it can judge the answer. */
    readonly get: (
      key: string,
      lookup: Effect.Effect<string, ReadError>,
      ttlMs?: number | (() => number),
    ) => Effect.Effect<string, ReadError>;
    readonly invalidate: Effect.Effect<void>;
  }
>()("t3/pullRequest/PullRequestReadCache") {}

export const make = Effect.gen(function* () {
  const backing = yield* KeyValueStore.KeyValueStore;
  const crypto = yield* Crypto.Crypto;
  const clock = yield* Clock.Clock;
  let enabled = true;
  const lock = yield* Semaphore.make(CONCURRENT_READS);
  const timeToLive: Persistable.TimeToLiveFn<Read> = (exit) =>
    Exit.isSuccess(exit)
      ? Duration.millis(Math.max(0, exit.value.expiresAt - clock.currentTimeMillisUnsafe()))
      : Duration.zero;
  const cache = yield* PersistedCache.make(
    (request: Read) =>
      request.lookup.pipe(
        Effect.map((payload) => ({
          payload,
          expiresAt:
            clock.currentTimeMillisUnsafe() +
            (typeof request.ttlMs === "number" ? request.ttlMs : request.ttlMs()),
        })),
      ),
    {
      storeId: STORE_ID,
      timeToLive,
      inMemoryTTL: timeToLive,
      inMemoryCapacity: CONCURRENT_READS,
    },
  );
  return PullRequestReadCache.of({
    get: Effect.fn("PullRequestReadCache.get")(function* (key, lookup, ttlMs = 60_000) {
      if (!enabled) return yield* lookup;
      const digest = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(key))
        .pipe(Effect.option);
      if (Option.isNone(digest)) return yield* lookup;
      const read = yield* Effect.cached(lookup);
      return yield* Effect.suspend(() =>
        enabled
          ? cache
              .get(new Read({ key: Encoding.encodeHex(digest.value), lookup: read, ttlMs }))
              .pipe(Effect.map((result) => result.payload))
          : read,
      ).pipe(
        Effect.catchTags({
          PersistenceError: () => read,
          SchemaError: () => read,
        }),
        Effect.uninterruptible,
        lock.withPermits(1),
      );
    }),
    // Let existing reads finish before clearing, so they cannot repopulate stale entries.
    invalidate: Cache.invalidateAll(cache.inMemory).pipe(
      Effect.andThen(backing.clear),
      Effect.catch(() => {
        enabled = false;
        return Effect.logWarning("PR cache disabled after clearing failed");
      }),
      lock.withPermits(CONCURRENT_READS),
    ),
  });
});

/**
 * Deletes entry files in `directory` not written within `ENTRY_FILE_MAX_AGE`.
 * The persisted cache drops an expired entry only when it is read again, so
 * files for PRs nobody reopens would otherwise stay forever.
 */
export const pruneExpiredEntryFiles = Effect.fn("PullRequestReadCache.pruneExpiredEntryFiles")(
  function* (directory: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cutoff = (yield* Clock.currentTimeMillis) - Duration.toMillis(ENTRY_FILE_MAX_AGE);
    const entries = (yield* fileSystem.readDirectory(directory)).filter((name) =>
      name.startsWith(STORE_ID),
    );
    // One file at a time, and `partition` visits every file, so one locked file
    // does not stop the sweep.
    const [, failures] = yield* Effect.partition(entries, (name) => {
      const entryPath = path.join(directory, name);
      return fileSystem.stat(entryPath).pipe(
        Effect.flatMap((info) =>
          Option.exists(info.mtime, (mtime) => mtime.getTime() < cutoff)
            ? fileSystem.remove(entryPath)
            : Effect.void,
        ),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
      );
    });
    if (failures.length > 0) {
      yield* Effect.logWarning("Failed to prune some PR cache files", {
        failed: failures.length,
        cause: failures[0],
      });
    }
  },
);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const directory = path.join(config.providerStatusCacheDir, "pull-requests");
    return Layer.effect(PullRequestReadCache, make).pipe(
      Layer.provide(Persistence.layerKvs),
      Layer.provide(
        KeyValueStore.layerFileSystem(directory).pipe(
          // Prunes once the server is active, then every hour.
          Layer.tap(() =>
            forkParked(
              pruneExpiredEntryFiles(directory).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to prune PR cache files", { cause }),
                ),
                Effect.repeat(Schedule.spaced(Duration.hours(1))),
              ),
            ),
          ),
          Layer.catch(() =>
            Layer.effectDiscard(
              Effect.logWarning("PR cache directory unavailable; using memory cache"),
            ).pipe(Layer.provideMerge(KeyValueStore.layerMemory)),
          ),
        ),
      ),
    );
  }),
);
