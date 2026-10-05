import { DesktopSshEnvironmentTargetSchema, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";

const ConnectionProfileBase = {
  connectionId: Schema.String,
  environmentId: EnvironmentId,
  label: Schema.String,
};

export class BearerConnectionProfile extends Schema.TaggedClass<BearerConnectionProfile>()(
  "BearerConnectionProfile",
  {
    ...ConnectionProfileBase,
    httpBaseUrl: Schema.String,
    wsBaseUrl: Schema.String,
  },
) {}

export class SshConnectionProfile extends Schema.TaggedClass<SshConnectionProfile>()(
  "SshConnectionProfile",
  {
    ...ConnectionProfileBase,
    target: DesktopSshEnvironmentTargetSchema,
  },
) {}

export const ConnectionProfile = Schema.Union([BearerConnectionProfile, SshConnectionProfile]);
export type ConnectionProfile = typeof ConnectionProfile.Type;

export interface ConnectionCatalogEntry {
  readonly target: ConnectionTarget;
  readonly profile: Option.Option<ConnectionProfile>;
  /** False when the user switched the environment off: saved, but never connects. */
  readonly enabled: boolean;
  /** Discovery rejection stays visible while the saved connection is switched off. */
  readonly unsupportedReason?: string;
}

export class BearerConnectionCredential extends Schema.TaggedClass<BearerConnectionCredential>()(
  "BearerConnectionCredential",
  {
    token: Schema.String,
  },
) {}

export const ConnectionCredential = Schema.Union([BearerConnectionCredential]);
export type ConnectionCredential = typeof ConnectionCredential.Type;

export class PrimaryConnectionRegistration extends Schema.TaggedClass<PrimaryConnectionRegistration>()(
  "PrimaryConnectionRegistration",
  {
    target: PrimaryConnectionTarget,
  },
) {}

export class RelayConnectionRegistration extends Schema.TaggedClass<RelayConnectionRegistration>()(
  "RelayConnectionRegistration",
  {
    target: RelayConnectionTarget,
  },
) {}

export class BearerConnectionRegistration extends Schema.TaggedClass<BearerConnectionRegistration>()(
  "BearerConnectionRegistration",
  {
    target: BearerConnectionTarget,
    profile: BearerConnectionProfile,
    credential: BearerConnectionCredential,
  },
) {}

export class SshConnectionRegistration extends Schema.TaggedClass<SshConnectionRegistration>()(
  "SshConnectionRegistration",
  {
    target: SshConnectionTarget,
    profile: SshConnectionProfile,
  },
) {}

export const ConnectionRegistration = Schema.Union([
  RelayConnectionRegistration,
  BearerConnectionRegistration,
  SshConnectionRegistration,
]);
export type ConnectionRegistration = typeof ConnectionRegistration.Type;

/**
 * Platform-managed registrations are reconciled from the host (the desktop
 * bootstrap IPC) rather than persisted by the user. They cover the primary
 * local environment plus any additional desktop-local backends running
 * alongside it (e.g. a parallel WSL backend). The primary stays on same-origin
 * cookie auth (`PrimaryConnectionRegistration`); secondary local backends live
 * on a separate loopback origin and authenticate with a bearer token minted
 * from their bootstrap credential (`BearerConnectionRegistration`).
 */
export const PlatformConnectionRegistration = Schema.Union([
  PrimaryConnectionRegistration,
  BearerConnectionRegistration,
]);
export type PlatformConnectionRegistration = typeof PlatformConnectionRegistration.Type;

export function connectionRegistrationTarget(
  registration: ConnectionRegistration | PrimaryConnectionRegistration,
): ConnectionTarget {
  return registration.target;
}

export function connectionRegistrationCatalogEntry(
  registration: ConnectionRegistration | PrimaryConnectionRegistration,
): ConnectionCatalogEntry {
  switch (registration._tag) {
    case "PrimaryConnectionRegistration":
    case "RelayConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.none(),
        enabled: true,
      };
    case "BearerConnectionRegistration":
    case "SshConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.some(registration.profile),
        enabled: true,
      };
  }
}

/**
 * Identifies the saved endpoint behind an entry: the relay environment, the
 * SSH host, or the normalized HTTP/WS base URLs. Two entries with the same key
 * reach the same server the same way, so state learned about one (such as a
 * discovery rejection) carries over when the entry is re-registered. Null when
 * the entry has no saved endpoint to compare (a bearer target whose profile is
 * missing, or a URL that is not a plain http/ws origin).
 */
export function connectionEndpointKey(entry: ConnectionCatalogEntry): string | null {
  const target = entry.target;
  if (target._tag === "RelayConnectionTarget") {
    return JSON.stringify([target._tag, target.environmentId]);
  }
  const profile = Option.getOrNull(entry.profile);
  if (target._tag === "SshConnectionTarget") {
    if (profile?._tag !== "SshConnectionProfile") return null;
    const { alias, hostname, username, port } = profile.target;
    return JSON.stringify([target._tag, target.environmentId, alias, hostname, username, port]);
  }
  const baseUrls =
    target._tag === "PrimaryConnectionTarget"
      ? [target.httpBaseUrl, target.wsBaseUrl]
      : profile?._tag === "BearerConnectionProfile"
        ? [profile.httpBaseUrl, profile.wsBaseUrl]
        : null;
  if (baseUrls === null) return null;
  try {
    const urls = baseUrls.map((baseUrl) => new URL(baseUrl));
    if (
      !["http:", "https:"].includes(urls[0]!.protocol) ||
      !["ws:", "wss:"].includes(urls[1]!.protocol) ||
      urls.some((url) => url.username || url.password)
    ) {
      return null;
    }
    return JSON.stringify([
      target._tag,
      target.environmentId,
      ...urls.map((url) => url.href.replace(/\/+$/, "")),
    ]);
  } catch {
    return null;
  }
}
