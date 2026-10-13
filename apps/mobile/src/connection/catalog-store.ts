import {
  ConnectionCatalogDocument,
  type ConnectionCatalogDocument as ConnectionCatalogDocumentType,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
} from "@t3tools/client-runtime/platform";
import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as MobileSecureStorage from "../persistence/mobile-secure-storage";
import { migrateLegacyConnectionCatalog } from "./migration";
import {
  catalogFromSwiftEnvironments,
  SWIFT_IMPORT_MARKER_KEY,
  type SwiftSavedEnvironments,
} from "./swift-import";

export const CONNECTION_CATALOG_KEY = "t3code.connection-catalog.v1";
export const LEGACY_CONNECTIONS_KEY = "t3code.connections";

function catalogError(operation: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not ${operation} the local connection catalog: ${String(cause)}`,
  });
}

const ConnectionCatalogDocumentJson = Schema.fromJsonString(ConnectionCatalogDocument);
const decodeConnectionCatalogDocument = Schema.decodeEffect(ConnectionCatalogDocumentJson);
const encodeConnectionCatalogDocument = Schema.encodeEffect(ConnectionCatalogDocumentJson);

const decodeCatalog = Effect.fn("mobile.connectionStorage.decodeCatalog")(function* (raw: string) {
  return yield* decodeConnectionCatalogDocument(raw).pipe(
    Effect.mapError((cause) => catalogError("decode", cause)),
  );
});

const encodeCatalog = Effect.fn("mobile.connectionStorage.encodeCatalog")(function* (
  catalog: ConnectionCatalogDocumentType,
) {
  return yield* encodeConnectionCatalogDocument(catalog).pipe(
    Effect.mapError((cause) => catalogError("encode", cause)),
  );
});

interface CatalogStore {
  readonly read: Effect.Effect<ConnectionCatalogDocumentType, ConnectionTransientError>;
  readonly update: (
    transform: (catalog: ConnectionCatalogDocumentType) => ConnectionCatalogDocumentType,
  ) => Effect.Effect<void, ConnectionTransientError>;
}

export interface CatalogStoreOptions {
  /**
   * Reads what the SwiftUI client saved under the same bundle id. When given,
   * the first load imports it once, replacing whatever catalog is stored.
   */
  readonly readSwiftSavedEnvironments?: Effect.Effect<SwiftSavedEnvironments | null, unknown>;
}

export const make = Effect.fn("mobile.connectionStorage.makeCatalogStore")(function* (
  options: CatalogStoreOptions = {},
) {
  const storage = yield* MobileSecureStorage.MobileSecureStorage;
  const getItem = (key: string) =>
    storage.getItem(key).pipe(Effect.mapError((cause) => catalogError("load", cause)));
  const setItem = (key: string, value: string) =>
    storage.setItem(key, value).pipe(Effect.mapError((cause) => catalogError("save", cause)));
  const deleteItem = (key: string) =>
    storage.removeItem(key).pipe(Effect.mapError((cause) => catalogError("delete", cause)));
  const state = yield* Ref.make<Option.Option<ConnectionCatalogDocumentType>>(Option.none());
  const lock = yield* Semaphore.make(1);

  const loadLegacyCatalog = Effect.fn("mobile.connectionStorage.loadLegacyCatalog")(function* () {
    const legacyRaw = yield* getItem(LEGACY_CONNECTIONS_KEY);
    const catalog =
      legacyRaw === null || legacyRaw.trim() === ""
        ? EMPTY_CONNECTION_CATALOG_DOCUMENT
        : yield* migrateLegacyConnectionCatalog(legacyRaw).pipe(
            Effect.mapError((cause) => catalogError("migrate", cause)),
            Effect.catch((error) =>
              Effect.logWarning("Discarding corrupt legacy mobile connections", error).pipe(
                Effect.as(EMPTY_CONNECTION_CATALOG_DOCUMENT),
              ),
            ),
          );
    if (legacyRaw !== null && legacyRaw.trim() !== "") {
      const encoded = yield* encodeCatalog(catalog);
      yield* setItem(CONNECTION_CATALOG_KEY, encoded);
      yield* deleteItem(LEGACY_CONNECTIONS_KEY);
    }
    return catalog;
  });

  // The Swift catalog replaces the stored one rather than merging: the stored
  // one can only be the React Native client's, which predates the Swift
  // client and was already imported into it. A failed read sets no marker, so
  // the next launch tries again; it never blocks loading the catalog.
  const importSwiftCatalogOnce = Effect.fn("mobile.connectionStorage.importSwiftCatalog")(
    function* (readSaved: Effect.Effect<SwiftSavedEnvironments | null, unknown>) {
      if ((yield* getItem(SWIFT_IMPORT_MARKER_KEY)) !== null) return;
      const saved = yield* readSaved;
      const catalog = saved === null ? null : catalogFromSwiftEnvironments(saved);
      if (catalog !== null) {
        yield* setItem(CONNECTION_CATALOG_KEY, yield* encodeCatalog(catalog));
      }
      yield* setItem(SWIFT_IMPORT_MARKER_KEY, "1");
    },
    Effect.catch((cause) =>
      Effect.logWarning("Could not import the Swift client's servers", cause),
    ),
  );

  const loadUnlocked = Effect.fn("mobile.connectionStorage.loadCatalog")(function* () {
    const cached = yield* Ref.get(state);
    if (Option.isSome(cached)) {
      return cached.value;
    }
    if (options.readSwiftSavedEnvironments !== undefined) {
      yield* importSwiftCatalogOnce(options.readSwiftSavedEnvironments);
    }
    const raw = yield* getItem(CONNECTION_CATALOG_KEY);
    let catalog: ConnectionCatalogDocumentType;
    if (raw !== null && raw.trim() !== "") {
      catalog = yield* decodeCatalog(raw).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Discarding corrupt mobile connection catalog", error).pipe(
            Effect.andThen(deleteItem(CONNECTION_CATALOG_KEY)),
            Effect.andThen(loadLegacyCatalog()),
          ),
        ),
      );
    } else {
      catalog = yield* loadLegacyCatalog();
    }
    yield* Ref.set(state, Option.some(catalog));
    return catalog;
  });

  const read = lock.withPermits(1)(loadUnlocked());
  const update: CatalogStore["update"] = Effect.fn("mobile.connectionStorage.updateCatalog")(
    function* (transform) {
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const next = transform(yield* loadUnlocked());
          const encoded = yield* encodeCatalog(next);
          yield* setItem(CONNECTION_CATALOG_KEY, encoded);
          yield* Ref.set(state, Option.some(next));
        }),
      );
    },
  );

  return { read, update } satisfies CatalogStore;
});
