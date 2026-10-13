import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  type ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
} from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Set once the SwiftUI client's environments were imported (or found absent),
 * so the import never runs again and never overwrites later changes.
 */
export const SWIFT_IMPORT_MARKER_KEY = "t3code.swift-import.v1";

/**
 * What the SwiftUI client saved under the same bundle id, as read by the
 * `T3SwiftImport` native module: its `environments.json` and the raw Keychain
 * credentials keyed by credential id.
 */
export interface SwiftSavedEnvironments {
  readonly catalog?: string;
  readonly credentials: Readonly<Record<string, string>>;
}

const SwiftRoute = Schema.Struct({
  httpBaseURL: Schema.String,
  webSocketBaseURL: Schema.String,
  kind: Schema.String,
  credentialID: Schema.String,
  learned: Schema.optionalKey(Schema.Boolean),
  tailscaleConfirmed: Schema.optionalKey(Schema.Boolean),
});
type SwiftRoute = typeof SwiftRoute.Type;

const SwiftEnvironment = Schema.Struct({
  id: EnvironmentId,
  label: Schema.String,
  routes: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  // Catalogs saved before routes existed describe the one address here.
  httpBaseURL: Schema.optionalKey(Schema.String),
  webSocketBaseURL: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
});
type SwiftEnvironment = typeof SwiftEnvironment.Type;

const SwiftCatalog = Schema.fromJsonString(
  Schema.Struct({ environments: Schema.Array(Schema.Unknown) }),
);
const SwiftCredential = Schema.fromJsonString(
  Schema.Struct({
    accessToken: Schema.String,
    authorizationMethod: Schema.optionalKey(Schema.String),
  }),
);

const decodeCatalog = Schema.decodeUnknownOption(SwiftCatalog);
const decodeEnvironment = Schema.decodeUnknownOption(SwiftEnvironment);
const decodeRoute = Schema.decodeUnknownOption(SwiftRoute);
const decodeCredential = Schema.decodeUnknownOption(SwiftCredential);

function savedRoutes(environment: SwiftEnvironment): ReadonlyArray<SwiftRoute> {
  // Like the Swift decoder: a route this build cannot read is dropped, not
  // the environment.
  const routes = (environment.routes ?? []).flatMap((route) => Option.toArray(decodeRoute(route)));
  if (routes.length > 0) return routes;
  if (environment.httpBaseURL && environment.webSocketBaseURL && environment.kind) {
    return [
      {
        httpBaseURL: environment.httpBaseURL,
        webSocketBaseURL: environment.webSocketBaseURL,
        kind: environment.kind,
        credentialID: environment.id,
      },
    ];
  }
  return [];
}

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * The connection catalog for what the SwiftUI client saved, or null when it
 * saved no catalog (a fresh install, or a device that never ran it).
 *
 * Carries over what the user paired: each direct route with its bearer token,
 * and the T3 Connect route, which reconnects after signing in to T3 Connect
 * again. Routes the server reported (learned) are left out; they are learned
 * again on the first connection. A direct route whose token is missing is
 * dropped, and so is an environment left with no route. Switched-off
 * environments stay switched off. Nothing else the Swift client stored is
 * imported.
 */
export function catalogFromSwiftEnvironments(
  saved: SwiftSavedEnvironments,
): ConnectionCatalogDocument | null {
  if (saved.catalog === undefined) return null;
  const catalog = Option.getOrNull(decodeCatalog(saved.catalog));
  if (catalog === null) return null;

  const targets: Array<ConnectionCatalogDocument["targets"][number]> = [];
  const profiles: Array<ConnectionCatalogDocument["profiles"][number]> = [];
  const credentials: Array<ConnectionCatalogDocument["credentials"][number]> = [];
  const disabledEnvironmentIds: Array<EnvironmentId> = [];
  const seenEnvironments = new Set<string>();

  for (const raw of catalog.environments) {
    const environment = Option.getOrNull(decodeEnvironment(raw));
    if (environment === null || seenEnvironments.has(environment.id)) continue;
    seenEnvironments.add(environment.id);

    const { id: environmentId, label } = environment;
    const environmentTargets: Array<ConnectionCatalogDocument["targets"][number]> = [];
    const seenRoutes = new Set<string>();
    for (const route of savedRoutes(environment)) {
      if (route.learned === true) continue;
      if (route.kind === "managed-dpop") {
        if (seenRoutes.has("relay")) continue;
        seenRoutes.add("relay");
        environmentTargets.push(new RelayConnectionTarget({ environmentId, label }));
        continue;
      }
      if (route.kind !== "bearer") continue;

      const origin = originOf(route.httpBaseURL);
      const rawCredential = saved.credentials[route.credentialID];
      const credential =
        rawCredential === undefined ? null : Option.getOrNull(decodeCredential(rawCredential));
      if (
        origin === null ||
        credential === null ||
        (credential.authorizationMethod ?? "bearer") !== "bearer" ||
        credential.accessToken.trim() === ""
      ) {
        continue;
      }
      // The id onboarding gives a route paired at this address.
      const connectionId = `bearer:${environmentId}:${origin}`;
      if (seenRoutes.has(connectionId)) continue;
      seenRoutes.add(connectionId);

      environmentTargets.push(new BearerConnectionTarget({ environmentId, label, connectionId }));
      profiles.push(
        new BearerConnectionProfile({
          connectionId,
          environmentId,
          label,
          httpBaseUrl: route.httpBaseURL,
          wsBaseUrl: route.webSocketBaseURL,
          ...(route.tailscaleConfirmed === true ? { network: "tailscale" as const } : {}),
        }),
      );
      credentials.push({
        connectionId,
        credential: new BearerConnectionCredential({ token: credential.accessToken }),
      });
    }

    if (environmentTargets.length === 0) continue;
    targets.push(...environmentTargets);
    if (environment.enabled === false) disabledEnvironmentIds.push(environmentId);
  }

  return {
    ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
    targets,
    profiles,
    credentials,
    disabledEnvironmentIds,
  };
}
