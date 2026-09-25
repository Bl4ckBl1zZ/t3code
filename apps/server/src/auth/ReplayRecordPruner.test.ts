import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { REPLAY_RECORDS } from "./ReplayRecordPruner.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

const makeSecretStoreLayer = () =>
  ServerSecretStore.layer.pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-replay-record-pruner-test-" }),
    ),
  );

/** Writes a secret and backdates its file to `age` before `NOW`. */
const writeSecretAged = (name: string, age: Duration.Input) =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { secretsDir } = yield* ServerConfig.ServerConfig;
    yield* secretStore.create(name, new TextEncoder().encode(name));
    const writtenAt = DateTime.toDateUtc(DateTime.makeUnsafe(NOW - Duration.toMillis(age)));
    yield* fileSystem.utimes(path.join(secretsDir, `${name}.bin`), writtenAt, writtenAt);
  });

const secretExists = (name: string) =>
  ServerSecretStore.ServerSecretStore.pipe(
    Effect.flatMap((secretStore) => secretStore.get(name)),
    Effect.map(Option.isSome),
  );

/**
 * Deletes `dpop-proof-vanishing` right before it is stat'd, as a concurrent
 * pass would, and refuses to remove `dpop-proof-locked`.
 */
const RacingFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      ...fileSystem,
      stat: (path) =>
        path.endsWith("/dpop-proof-vanishing.bin")
          ? fileSystem.remove(path).pipe(Effect.andThen(fileSystem.stat(path)))
          : fileSystem.stat(path),
      remove: (path, options) =>
        path.endsWith("/dpop-proof-locked.bin")
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "remove",
                pathOrDescriptor: path,
                description: "Permission denied while removing replay record.",
              }),
            )
          : fileSystem.remove(path, options),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

it.layer(NodeServices.layer)("ReplayRecordPruner", (it) => {
  it.effect("removes expired replay records and keeps recent ones and real secrets", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const expired = [
        "dpop-proof-expired",
        "cloud-mint-nonce-expired",
        "cloud-mint-jti-expired",
        "cloud-health-nonce-expired",
        "cloud-health-jti-expired",
      ];
      const recent = ["dpop-proof-recent", "cloud-mint-jti-recent", "cloud-health-nonce-recent"];
      const realSecrets = [
        "server-signing-key",
        "session-signing-key",
        "cloud-link-ed25519-private-key",
        "cloud-mint-ed25519-public-key",
        "cloud-relay-environment-credential",
        "provider-env-codex",
      ];
      for (const name of expired) {
        yield* writeSecretAged(name, Duration.hours(2));
      }
      for (const name of recent) {
        yield* writeSecretAged(name, Duration.minutes(10));
      }
      for (const name of realSecrets) {
        yield* writeSecretAged(name, Duration.days(365));
      }

      const result = yield* ServerSecretStore.removeExpired(REPLAY_RECORDS);

      assert.deepEqual(result, { removed: expired.length, failed: 0 });
      for (const name of expired) {
        assert.isFalse(yield* secretExists(name), name);
      }
      for (const name of [...recent, ...realSecrets]) {
        assert.isTrue(yield* secretExists(name), name);
      }
    }).pipe(Effect.provide(makeSecretStoreLayer())),
  );

  it.effect("skips records that vanish mid-pass and counts records it cannot remove", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      for (const name of ["dpop-proof-vanishing", "dpop-proof-locked", "dpop-proof-expired"]) {
        yield* writeSecretAged(name, Duration.hours(2));
      }

      const result = yield* ServerSecretStore.removeExpired(REPLAY_RECORDS);

      assert.deepEqual(result, { removed: 1, failed: 1 });
      assert.isFalse(yield* secretExists("dpop-proof-expired"));
      assert.isTrue(yield* secretExists("dpop-proof-locked"));
    }).pipe(Effect.provide(makeSecretStoreLayer().pipe(Layer.provideMerge(RacingFileSystemLayer)))),
  );
});
