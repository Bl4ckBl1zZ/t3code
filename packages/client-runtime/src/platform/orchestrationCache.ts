import {
  EnvironmentId,
  OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellSnapshotJson,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadProjectionJson,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ConnectionPersistenceError } from "./persistence.ts";

export const ORCHESTRATION_CACHE_SCHEMA_VERSION = 3 as const;

export const StoredOrchestrationShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(ORCHESTRATION_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  snapshot: OrchestrationV2ShellSnapshotJson,
});

const encodeProjectShells = Schema.encodeEffect(Schema.Array(OrchestrationProjectShell));
const saveShellError = (cause: unknown) =>
  new ConnectionPersistenceError({
    operation: "save-shell",
    message: `Could not save shell: ${String(cause)}`,
  });

/**
 * Serializes a shell snapshot for `EnvironmentCacheStore.saveShell`. The JSON
 * equals `Schema.fromJsonString(StoredOrchestrationShellSnapshot)` output, so
 * the cache format does not change. Walking thousands of threads through
 * Schema blocks the UI thread, and a thread shell's only encode transforms
 * turn `DateTime.Utc` into ISO strings, which `JSON.stringify` already does
 * through `DateTime.toJSON`. Only the projects go through Schema.
 */
export const stringifyStoredShellSnapshot = (
  environmentId: EnvironmentId,
  snapshot: OrchestrationV2ShellSnapshot,
) =>
  encodeProjectShells(snapshot.projects).pipe(
    Effect.mapError(saveShellError),
    Effect.flatMap((projects) =>
      Effect.try({
        try: () =>
          // @effect-diagnostics-next-line preferSchemaOverJson:off - see the doc comment.
          JSON.stringify({
            schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
            environmentId,
            snapshot: { ...snapshot, projects },
          }),
        catch: saveShellError,
      }),
    ),
  );

export const StoredOrchestrationThreadSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(ORCHESTRATION_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  snapshot: OrchestrationV2ThreadDetailSnapshot.mapFields((fields) => ({
    ...fields,
    projection: OrchestrationV2ThreadProjectionJson,
  })),
});

/** Invalid orchestration caches are disposable and must never block live synchronization. */
export function decodeOrDiscardOrchestrationCache<A, E, R, E2, R2>(
  decode: Effect.Effect<Option.Option<A>, E, R>,
  discard: Effect.Effect<void, E2, R2>,
) {
  return decode.pipe(Effect.catch(() => discard.pipe(Effect.as(Option.none<A>()))));
}
