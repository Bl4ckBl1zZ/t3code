import { describe, expect, it } from "@effect/vitest";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import { CONNECTION_CATALOG_KEY, make } from "./catalog-store";
import { catalogFromSwiftEnvironments, SWIFT_IMPORT_MARKER_KEY } from "./swift-import";
import * as MobileSecureStorage from "../persistence/mobile-secure-storage";

// Shapes as the Swift client's JSONEncoder writes them (sorted keys, unescaped
// slashes): `EnvironmentStore` documents and `EnvironmentCredential` values.
const bearerCredential = (token: string) =>
  JSON.stringify({ accessToken: token, authorizationMethod: "bearer", scopes: [] });
const dpopCredential = JSON.stringify({
  accessToken: "dpop-token",
  authorizationMethod: "dpop",
  expiresAt: 800000000,
  managedEnvironmentID: "env-relay",
  proofKeyThumbprint: "thumb",
  scopes: [],
});

const macbook = {
  enabled: true,
  httpBaseURL: "http://192.168.1.10:3773",
  id: "env-macbook",
  kind: "bearer",
  label: "MacBook",
  routes: [
    {
      credentialID: "env-macbook",
      httpBaseURL: "http://192.168.1.10:3773",
      id: "direct:http://192.168.1.10:3773",
      kind: "bearer",
      webSocketBaseURL: "ws://192.168.1.10:3773",
    },
    {
      credentialID: "env-macbook",
      httpBaseURL: "http://100.64.1.2:3773",
      id: "direct:http://100.64.1.2:3773",
      kind: "bearer",
      learned: true,
      tailscaleConfirmed: true,
      webSocketBaseURL: "ws://100.64.1.2:3773",
    },
    {
      credentialID: "env-macbook-tailnet",
      httpBaseURL: "https://macbook.tail1234.ts.net",
      id: "direct:https://macbook.tail1234.ts.net",
      kind: "bearer",
      tailscaleConfirmed: true,
      webSocketBaseURL: "wss://macbook.tail1234.ts.net",
    },
  ],
  webSocketBaseURL: "ws://192.168.1.10:3773",
};

const relayed = {
  enabled: false,
  httpBaseURL: "https://relay.example.org/env-relay",
  id: "env-relay",
  kind: "managed-dpop",
  label: "Studio",
  routes: [
    {
      credentialID: "env-relay",
      httpBaseURL: "https://relay.example.org/env-relay",
      id: "relay",
      kind: "managed-dpop",
      webSocketBaseURL: "wss://relay.example.org/env-relay",
    },
  ],
  unsupportedReason: "Update the server",
};

// Saved before routes existed: one address, credential under the env id.
const legacy = {
  httpBaseURL: "http://10.0.0.5:3773",
  id: "env-legacy",
  kind: "bearer",
  label: "Old box",
  webSocketBaseURL: "ws://10.0.0.5:3773",
};

const savedCatalog = (environments: ReadonlyArray<unknown>) =>
  JSON.stringify({ activeEnvironmentID: "env-macbook", environments, version: 1 });

const encodeDocument = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));
const decodeDocument = Schema.decodeSync(Schema.fromJsonString(ConnectionCatalogDocument));

describe("catalogFromSwiftEnvironments", () => {
  it("imports paired routes with their tokens and the T3 Connect route", () => {
    const catalog = catalogFromSwiftEnvironments({
      catalog: savedCatalog([macbook, relayed, legacy]),
      credentials: {
        "env-macbook": bearerCredential("mac-token"),
        "env-macbook-tailnet": bearerCredential("tailnet-token"),
        "env-relay": dpopCredential,
        "env-legacy": bearerCredential("legacy-token"),
      },
    });

    expect(catalog).not.toBeNull();
    // The result is a valid stored document.
    const document = decodeDocument(encodeDocument(catalog!));
    expect(document.targets.map((target) => [target._tag, target.environmentId])).toEqual([
      ["BearerConnectionTarget", "env-macbook"],
      ["BearerConnectionTarget", "env-macbook"],
      ["RelayConnectionTarget", "env-relay"],
      ["BearerConnectionTarget", "env-legacy"],
    ]);
    expect(
      document.profiles.map((profile) =>
        profile._tag === "BearerConnectionProfile"
          ? [profile.connectionId, profile.httpBaseUrl, profile.wsBaseUrl, profile.network]
          : null,
      ),
    ).toEqual([
      [
        "bearer:env-macbook:http://192.168.1.10:3773",
        "http://192.168.1.10:3773",
        "ws://192.168.1.10:3773",
        undefined,
      ],
      [
        "bearer:env-macbook:https://macbook.tail1234.ts.net",
        "https://macbook.tail1234.ts.net",
        "wss://macbook.tail1234.ts.net",
        "tailscale",
      ],
      [
        "bearer:env-legacy:http://10.0.0.5:3773",
        "http://10.0.0.5:3773",
        "ws://10.0.0.5:3773",
        undefined,
      ],
    ]);
    expect(
      document.credentials.map((entry) => [entry.connectionId, entry.credential.token]),
    ).toEqual([
      ["bearer:env-macbook:http://192.168.1.10:3773", "mac-token"],
      ["bearer:env-macbook:https://macbook.tail1234.ts.net", "tailnet-token"],
      ["bearer:env-legacy:http://10.0.0.5:3773", "legacy-token"],
    ]);
    expect(document.disabledEnvironmentIds).toEqual(["env-relay"]);
    expect(document.remoteDpopTokens).toEqual([]);
  });

  it("drops direct routes without a usable token and environments left with none", () => {
    const catalog = catalogFromSwiftEnvironments({
      catalog: savedCatalog([macbook, legacy, { id: "broken" }]),
      credentials: {
        "env-macbook": "{not-json",
        "env-macbook-tailnet": bearerCredential("tailnet-token"),
      },
    });

    expect(catalog?.targets.map((target) => target.environmentId)).toEqual(["env-macbook"]);
    expect(catalog?.credentials.map((entry) => entry.credential.token)).toEqual(["tailnet-token"]);
  });

  it("returns null without a Swift catalog and an empty catalog for an empty one", () => {
    expect(catalogFromSwiftEnvironments({ credentials: {} })).toBeNull();
    expect(catalogFromSwiftEnvironments({ catalog: "{not-json", credentials: {} })).toBeNull();
    expect(
      catalogFromSwiftEnvironments({ catalog: savedCatalog([]), credentials: {} })?.targets,
    ).toEqual([]);
  });
});

function makeStorage(initial: Readonly<Record<string, string>>) {
  const values = new Map(Object.entries(initial));
  const storage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        values.delete(key);
      }),
  });
  return { storage, values };
}

const staleReactNativeCatalog = encodeDocument({
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: ["stale" as never],
});

describe("Swift import in the catalog store", () => {
  it.effect("replaces the stored catalog once, then leaves later changes alone", () =>
    Effect.gen(function* () {
      const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: staleReactNativeCatalog });
      let reads = 0;
      const readSwiftSavedEnvironments = Effect.sync(() => {
        reads += 1;
        return {
          catalog: savedCatalog([legacy]),
          credentials: { "env-legacy": bearerCredential("legacy-token") },
        };
      });

      const first = yield* make({ readSwiftSavedEnvironments }).pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );
      const imported = yield* first.read;
      expect(imported.targets.map((target) => target.environmentId)).toEqual(["env-legacy"]);
      expect(imported.disabledEnvironmentIds).toEqual([]);
      expect(memory.values.get(SWIFT_IMPORT_MARKER_KEY)).toBe("1");

      yield* first.update((document) => ({ ...document, targets: [] }));
      const second = yield* make({ readSwiftSavedEnvironments }).pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );
      expect((yield* second.read).targets).toEqual([]);
      expect(reads).toBe(1);
    }),
  );

  it.effect("keeps the stored catalog and retries later when the Swift data cannot be read", () =>
    Effect.gen(function* () {
      const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: staleReactNativeCatalog });
      const catalog = yield* make({
        readSwiftSavedEnvironments: Effect.fail(new Error("errSecInteractionNotAllowed")),
      }).pipe(Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage));

      expect((yield* catalog.read).disabledEnvironmentIds).toEqual(["stale"]);
      expect(memory.values.has(SWIFT_IMPORT_MARKER_KEY)).toBe(false);
    }),
  );

  it.effect("marks a device without Swift data as done and keeps its catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: staleReactNativeCatalog });
      const catalog = yield* make({ readSwiftSavedEnvironments: Effect.succeed(null) }).pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).disabledEnvironmentIds).toEqual(["stale"]);
      expect(memory.values.get(SWIFT_IMPORT_MARKER_KEY)).toBe("1");
    }),
  );
});
