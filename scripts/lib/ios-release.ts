// @effect-diagnostics nodeBuiltinImport:off - Release tooling runs from plain node before an Effect runtime exists.
/**
 * Pure helpers for the direct-to-TestFlight iOS pipeline.
 *
 * Kept apart from `scripts/ios-testflight.sh` so the parts that are easy to get
 * subtly wrong — parsing a provisioning profile, picking the next build number —
 * are testable without Xcode, a signing identity, or a network call.
 */
import * as NodeCrypto from "node:crypto";

export interface ProvisioningProfile {
  readonly name: string;
  readonly uuid: string;
  readonly teamId: string;
  /** Bundle identifier, with the team prefix stripped. */
  readonly bundleIdentifier: string;
  /** First App Group in the profile's entitlements, when it grants any. */
  readonly appGroupIdentifier: string | undefined;
  readonly expiresAt: Date | undefined;
}

const PLIST_START = "<?xml";
const PLIST_END = "</plist>";

/**
 * A `.mobileprovision` is a CMS-signed blob wrapping a plain XML plist. Slicing
 * the plist out directly keeps this runnable off macOS (and in a unit test),
 * where `security cms -D` does not exist.
 */
export function extractProfilePlist(profile: Buffer): string {
  const text = profile.toString("latin1");
  const start = text.indexOf(PLIST_START);
  const end = text.indexOf(PLIST_END);
  if (start < 0 || end < 0) {
    throw new Error("Not a provisioning profile: no embedded plist found.");
  }
  return text.slice(start, end + PLIST_END.length);
}

function plistString(plist: string, key: string): string | undefined {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`, "u").exec(plist);
  return match?.[1];
}

function plistFirstArrayString(plist: string, key: string): string | undefined {
  const array = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`, "u").exec(plist);
  if (!array?.[1]) return undefined;
  return /<string>([\s\S]*?)<\/string>/u.exec(array[1])?.[1];
}

/**
 * Everything the release needs to know about an identity comes from the profile
 * itself. That matters beyond convenience: the App Group
 * (`group.com.bl4ckbl1zz.t3code.dev`) is not derivable from the bundle id
 * (`com.t3code.dev`), so any scheme that reconstructs it from convention is
 * wrong in a way that only shows up as a runtime entitlement failure.
 */
export function parseProvisioningProfile(profile: Buffer): ProvisioningProfile {
  const plist = extractProfilePlist(profile);
  const name = plistString(plist, "Name");
  const uuid = plistString(plist, "UUID");
  const applicationIdentifier = plistString(plist, "application-identifier");
  const teamId = plistFirstArrayString(plist, "TeamIdentifier");
  if (!name || !uuid || !applicationIdentifier || !teamId) {
    throw new Error("Provisioning profile is missing Name, UUID, TeamIdentifier, or app id.");
  }
  const prefix = `${teamId}.`;
  if (!applicationIdentifier.startsWith(prefix)) {
    throw new Error(
      `Provisioning profile app id ${applicationIdentifier} is not prefixed with team ${teamId}.`,
    );
  }
  const expiration = new RegExp("<key>ExpirationDate</key>\\s*<date>([\\s\\S]*?)</date>", "u").exec(
    plist,
  )?.[1];
  const expiresAt = expiration === undefined ? undefined : new Date(expiration);
  return {
    name,
    uuid,
    teamId,
    bundleIdentifier: applicationIdentifier.slice(prefix.length),
    appGroupIdentifier: plistFirstArrayString(plist, "com.apple.security.application-groups"),
    ...(expiresAt !== undefined && !Number.isNaN(expiresAt.getTime()) ? { expiresAt } : {}),
  };
}

/**
 * Highest `CFBundleVersion` already on App Store Connect, plus one.
 *
 * Every build number in play is an integer, but ASC returns them as strings and
 * sorts them lexicographically — under which "9" outranks "10". Comparing
 * numerically is the whole point of this function.
 */
export function nextBuildNumber(existingVersions: ReadonlyArray<string>): number {
  let highest = 0;
  for (const version of existingVersions) {
    // A build number may be dotted ("1.2.3"); its leading component is the one
    // that increments, and Apple orders the rest below it.
    const leading = Number.parseInt(version.split(".")[0] ?? "", 10);
    if (Number.isFinite(leading) && leading > highest) highest = leading;
  }
  return highest + 1;
}

function base64Url(value: Buffer | string): string {
  return (typeof value === "string" ? Buffer.from(value) : value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * ES256 JWT for the App Store Connect API.
 *
 * Apple rejects tokens valid for more than 20 minutes, so `expiresInSeconds`
 * stays well under that rather than defaulting to something generous.
 */
export function createAscToken(input: {
  readonly keyId: string;
  readonly issuerId: string;
  readonly privateKeyPem: string;
  readonly issuedAt: number;
  readonly expiresInSeconds?: number;
}): string {
  const header = { alg: "ES256", kid: input.keyId, typ: "JWT" };
  const payload = {
    iss: input.issuerId,
    iat: input.issuedAt,
    exp: input.issuedAt + (input.expiresInSeconds ?? 600),
    aud: "appstoreconnect-v1",
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), {
    key: input.privateKeyPem,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64Url(signature)}`;
}

export interface ResolvedAppConfig {
  readonly extra?: {
    readonly clerk?: { readonly publishableKey?: unknown };
    readonly relay?: { readonly url?: unknown };
  };
}

/**
 * Under EAS these values arrived from the hosted "production" environment. A
 * direct build has to supply them itself — and a missing Clerk key does not fail
 * the build, it ships a TestFlight binary that cannot sign in. Checking the
 * *resolved* config rather than env var names matters because the key may
 * legitimately arrive as `T3CODE_`, `VITE_`, or `EXPO_PUBLIC_`.
 */
export function missingAppConfigValues(config: ResolvedAppConfig): ReadonlyArray<string> {
  const missing: Array<string> = [];
  // `loadRepoEnv` serializes an unset value to `{}`, which is truthy, so a
  // non-empty string is the only shape that counts as present.
  const present = (value: unknown): boolean => typeof value === "string" && value.length > 0;
  if (!present(config.extra?.clerk?.publishableKey)) {
    missing.push("Clerk publishable key (T3CODE_CLERK_PUBLISHABLE_KEY)");
  }
  if (!present(config.extra?.relay?.url)) missing.push("relay URL (T3CODE_RELAY_URL)");
  return missing;
}

/**
 * Info.plist `CFBundleVersion` values that disagree with the build number.
 *
 * The app and widget targets bake a literal at prebuild while the sharing
 * extension keeps `$(CURRENT_PROJECT_VERSION)` and resolves it later, so only
 * literals can be compared — a build setting reference is not a mismatch, it is
 * simply not known yet.
 *
 * Worth checking because the failure it catches is the one that cost the EAS
 * pipeline a dedicated "sync extension build number" step: an extension
 * archiving as CFBundleVersion 1 against an app at 42 is rejected by Xcode at
 * the very end of the archive, with an error that does not name the cause.
 */
export function mismatchedBundleVersions(
  buildNumber: string,
  plists: ReadonlyArray<{ readonly label: string; readonly bundleVersion: string }>,
): ReadonlyArray<string> {
  return plists.flatMap(({ label, bundleVersion }) => {
    if (bundleVersion.includes("$(")) return [];
    return bundleVersion === buildNumber
      ? []
      : [`${label} is ${bundleVersion}, expected ${buildNumber}`];
  });
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * `exportArchive` resolves every embedded target separately and fails on the
 * first one it cannot map to a profile, so the widget and sharing extensions
 * have to be named here alongside the app.
 *
 * `manageAppVersionAndBuildNumber` is false because the build number was already
 * resolved from App Store Connect before the archive; letting Xcode manage it
 * here would silently overwrite that with its own guess.
 */
export function renderExportOptionsPlist(input: {
  readonly teamId: string;
  readonly bundleIdentifier: string;
  readonly appProfile: string;
  readonly widgetsProfile: string;
  readonly sharingProfile?: string | undefined;
}): string {
  const profiles: ReadonlyArray<readonly [string, string]> = [
    [input.bundleIdentifier, input.appProfile],
    [`${input.bundleIdentifier}.widgets`, input.widgetsProfile],
    ...(input.sharingProfile === undefined
      ? []
      : ([[`${input.bundleIdentifier}.sharing`, input.sharingProfile]] as const)),
  ];
  const entries = profiles
    .map(([id, name]) => `\t\t<key>${escapeXml(id)}</key>\n\t\t<string>${escapeXml(name)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>method</key>
\t<string>app-store-connect</string>
\t<key>destination</key>
\t<string>export</string>
\t<key>teamID</key>
\t<string>${escapeXml(input.teamId)}</string>
\t<key>signingStyle</key>
\t<string>manual</string>
\t<key>signingCertificate</key>
\t<string>Apple Distribution</string>
\t<key>manageAppVersionAndBuildNumber</key>
\t<false/>
\t<key>stripSwiftSymbols</key>
\t<true/>
\t<key>uploadSymbols</key>
\t<true/>
\t<key>provisioningProfiles</key>
\t<dict>
${entries}
\t</dict>
</dict>
</plist>
`;
}

export interface AscBuildsResponse {
  readonly data?: ReadonlyArray<{ readonly attributes?: { readonly version?: string } }>;
}

export function buildVersionsFromAscResponse(response: AscBuildsResponse): ReadonlyArray<string> {
  return (response.data ?? []).flatMap((entry) =>
    typeof entry.attributes?.version === "string" ? [entry.attributes.version] : [],
  );
}
