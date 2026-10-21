import {
  AuthEnvironmentMaintainScope,
  sessionGrantsScope,
  type AuthSessionState,
  type ExecutionEnvironmentCapabilities,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  cliReleaseChannelOf,
  cliReleasesPageUrl,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
  releaseSourcePublishesCli,
  UPSTREAM_RELEASE_SOURCE,
  type ReleaseSource,
} from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";

export function canMaintainEnvironment(session: AuthSessionState | null, connected: boolean) {
  return (
    connected &&
    session?.authenticated === true &&
    sessionGrantsScope(session, AuthEnvironmentMaintainScope)
  );
}

/**
 * Whether this app checks and installs updates for the host. Only upstream
 * publishes the `t3` CLI, so an app released elsewhere follows desktop-app
 * hosts only, which install from their own app's update feed.
 */
export function tracksEnvironmentReleases(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "serverSelfUpdate">,
  source: ReleaseSource = UPSTREAM_RELEASE_SOURCE,
) {
  return releaseSourcePublishesCli(source) || capabilities.serverSelfUpdate === "desktop-managed";
}

export function supportsEnvironmentUpdate(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "serverSelfUpdate" | "desktopAppUpdate">,
  source: ReleaseSource = UPSTREAM_RELEASE_SOURCE,
) {
  return (
    tracksEnvironmentReleases(capabilities, source) &&
    capabilities.serverSelfUpdate !== undefined &&
    (capabilities.serverSelfUpdate !== "desktop-managed" || capabilities.desktopAppUpdate === true)
  );
}

export function canUpdateEnvironmentProvider(provider: ServerProvider) {
  const compatibility = provider.compatibilityAdvisory?.latestVersionStatus;
  return (
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.canUpdate &&
    provider.versionAdvisory.latestVersion !== null &&
    compatibility !== "broken" &&
    compatibility !== "unsupported" &&
    provider.updateState?.status !== "running" &&
    provider.updateState?.status !== "queued"
  );
}

const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.optionalKey(Schema.Boolean),
});
const decodeRelease = Schema.decodeUnknownSync(Release);
const decodeReleases = Schema.decodeUnknownSync(Schema.Array(Release));

async function fetchReleases(url: string, accept: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, headers: { Accept: accept } });
  if (!response.ok) throw new Error(`Could not check releases (${response.status}). Try again.`);
  return response;
}

export async function findEnvironmentUpdate(
  currentVersion: string,
  signal: AbortSignal,
  source: ReleaseSource = UPSTREAM_RELEASE_SOURCE,
) {
  const channel = cliReleaseChannelOf(currentVersion);
  // Public release pages avoid the anonymous API quota shared by devices on the same network.
  const releasesPage = cliReleasesPageUrl(source);
  const response = await fetchReleases(
    channel === "stable" ? `${releasesPage}/latest` : `${releasesPage}.atom`,
    channel === "stable" ? "application/json" : "application/atom+xml",
    signal,
  );
  const releases =
    channel === "stable"
      ? [decodeRelease(await response.json())]
      : Array.from(
          (await response.text()).matchAll(
            /<id>tag:github\.com,2008:Repository\/\d+\/([^<]+)<\/id>/g,
          ),
          ([, tag_name = ""]) => ({ tag_name }),
        );
  let version = newestCliReleaseVersion(releases, channel, source.tagPrefix);

  // The feed only includes ten releases, so later nightlies can displace a published preview.
  for (let page = 1; version === undefined; page++) {
    const response = await fetchReleases(
      cliReleaseIndexPageUrl(page, source),
      "application/vnd.github+json",
      signal,
    );
    const releases = decodeReleases(await response.json());
    version = newestCliReleaseVersion(releases, channel, source.tagPrefix);
    if (releases.length < 100) break;
  }

  if (version === undefined) throw new Error(`No ${channel} release was found.`);
  return compareSemverVersions(version, currentVersion) > 0 ? version : null;
}
