import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import {
  buildVersionsFromAscResponse,
  createAscToken,
  extractProfilePlist,
  missingAppConfigValues,
  mismatchedBundleVersions,
  nextBuildNumber,
  parseProvisioningProfile,
  renderExportOptionsPlist,
} from "./ios-release.ts";

const PROFILE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AppIDName</key>
	<string>bl4ckbl1zz t3code dev</string>
	<key>TeamIdentifier</key>
	<array>
		<string>6V7XX6L5ZK</string>
	</array>
	<key>Entitlements</key>
	<dict>
		<key>application-identifier</key>
		<string>6V7XX6L5ZK.com.t3code.dev</string>
		<key>com.apple.security.application-groups</key>
		<array>
			<string>group.com.bl4ckbl1zz.t3code.dev</string>
		</array>
	</dict>
	<key>Name</key>
	<string>T3 Code App Store</string>
	<key>UUID</key>
	<string>b10a685d-b05b-428e-b618-93c328b5a514</string>
	<key>ExpirationDate</key>
	<date>2027-07-30T16:46:45Z</date>
</dict>
</plist>`;

/** A real profile is a CMS envelope; only the plist in the middle is readable. */
const signedProfile = (plist: string): Buffer =>
  Buffer.concat([
    Buffer.from([0x30, 0x82, 0x0a, 0x1b, 0x06, 0x09, 0x2a]),
    Buffer.from(plist, "utf8"),
    Buffer.from([0xa0, 0x82, 0x04, 0x00, 0x31, 0x82]),
  ]);

describe("extractProfilePlist", () => {
  it("slices the plist out of a CMS envelope", () => {
    expect(extractProfilePlist(signedProfile(PROFILE_PLIST))).toBe(PROFILE_PLIST);
  });

  it("rejects a file that is not a provisioning profile", () => {
    expect(() => extractProfilePlist(Buffer.from("nope"))).toThrow(/no embedded plist/u);
  });
});

describe("parseProvisioningProfile", () => {
  const profile = parseProvisioningProfile(signedProfile(PROFILE_PLIST));

  it("reads the identity Apple actually issued", () => {
    expect(profile).toMatchObject({
      name: "T3 Code App Store",
      uuid: "b10a685d-b05b-428e-b618-93c328b5a514",
      teamId: "6V7XX6L5ZK",
      bundleIdentifier: "com.t3code.dev",
    });
  });

  // The whole reason identity is read from the profile: this cannot be derived
  // from the bundle id by any naming convention.
  it("reads an App Group unrelated to the bundle identifier", () => {
    expect(profile.appGroupIdentifier).toBe("group.com.bl4ckbl1zz.t3code.dev");
  });

  it("strips the team prefix from the bundle identifier", () => {
    expect(profile.bundleIdentifier.startsWith("6V7XX6L5ZK")).toBe(false);
  });

  it("parses the expiry date", () => {
    expect(profile.expiresAt?.toISOString()).toBe("2027-07-30T16:46:45.000Z");
  });

  it("tolerates a profile granting no App Group", () => {
    const withoutGroup = PROFILE_PLIST.replace(
      /<key>com\.apple\.security\.application-groups<\/key>\s*<array>[\s\S]*?<\/array>/u,
      "",
    );
    expect(
      parseProvisioningProfile(signedProfile(withoutGroup)).appGroupIdentifier,
    ).toBeUndefined();
  });

  it("rejects an app id that does not match the team", () => {
    const mismatched = PROFILE_PLIST.replace(
      "6V7XX6L5ZK.com.t3code.dev",
      "OTHERTEAM.com.t3code.dev",
    );
    expect(() => parseProvisioningProfile(signedProfile(mismatched))).toThrow(/not prefixed/u);
  });

  it("rejects a profile missing its name", () => {
    const nameless = PROFILE_PLIST.replace(
      "<key>Name</key>\n\t<string>T3 Code App Store</string>",
      "",
    );
    expect(() => parseProvisioningProfile(signedProfile(nameless))).toThrow(/missing/u);
  });
});

describe("nextBuildNumber", () => {
  // App Store Connect returns build numbers as strings and sorts them
  // lexicographically, where "9" > "10". Uploading 10 twice is rejected.
  it("compares numerically rather than lexicographically", () => {
    expect(nextBuildNumber(["9", "10", "8"])).toBe(11);
  });

  it("starts at 1 for an app with no builds", () => {
    expect(nextBuildNumber([])).toBe(1);
  });

  it("increments the leading component of a dotted build number", () => {
    expect(nextBuildNumber(["12.3.1"])).toBe(13);
  });

  it("ignores unparseable versions", () => {
    expect(nextBuildNumber(["", "abc", "4"])).toBe(5);
  });
});

describe("createAscToken", () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const issuedAt = 1_800_000_000;
  const token = createAscToken({
    keyId: "ABC123",
    issuerId: "issuer-uuid",
    privateKeyPem,
    issuedAt,
  });
  const [header, payload, signature] = token.split(".");

  const decode = (segment: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

  it("signs with ES256 and names the key", () => {
    expect(decode(header!)).toEqual({ alg: "ES256", kid: "ABC123", typ: "JWT" });
  });

  it("addresses the App Store Connect audience", () => {
    expect(decode(payload!)).toMatchObject({ iss: "issuer-uuid", aud: "appstoreconnect-v1" });
  });

  // Apple rejects tokens with a lifetime over 20 minutes.
  it("expires well inside Apple's 20 minute ceiling", () => {
    const claims = decode(payload!);
    expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(1200);
    expect(Number(claims.exp)).toBeGreaterThan(issuedAt);
  });

  it("produces a signature Apple's verifier would accept", () => {
    const verified = NodeCrypto.verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature!, "base64url"),
    );
    expect(verified).toBe(true);
  });

  it("emits url-safe base64 with no padding", () => {
    expect(token).not.toMatch(/[+/=]/u);
  });
});

describe("missingAppConfigValues", () => {
  const complete = {
    extra: { clerk: { publishableKey: "pk_test_x" }, relay: { url: "https://relay.example" } },
  };

  it("passes a fully resolved config", () => {
    expect(missingAppConfigValues(complete)).toEqual([]);
  });

  // The failure this exists to prevent: the build succeeds and TestFlight gets a
  // binary that cannot sign in.
  it("catches a missing Clerk key", () => {
    expect(missingAppConfigValues({ extra: { relay: { url: "https://relay.example" } } })).toEqual([
      "Clerk publishable key (T3CODE_CLERK_PUBLISHABLE_KEY)",
    ]);
  });

  it("catches a missing relay URL", () => {
    expect(missingAppConfigValues({ extra: { clerk: { publishableKey: "pk" } } })).toEqual([
      "relay URL (T3CODE_RELAY_URL)",
    ]);
  });

  it("reports everything missing from an empty config", () => {
    expect(missingAppConfigValues({})).toHaveLength(2);
  });

  // `loadRepoEnv` serializes an unset value to `{}`, which is truthy — a plain
  // falsiness check would wave this through.
  it("rejects the empty-object shape an unset value serializes to", () => {
    expect(
      missingAppConfigValues({
        extra: { clerk: { publishableKey: {} }, relay: { url: "https://relay.example" } },
      }),
    ).toHaveLength(1);
  });

  it("rejects an empty string", () => {
    expect(
      missingAppConfigValues({
        extra: { clerk: { publishableKey: "" }, relay: { url: "https://relay.example" } },
      }),
    ).toHaveLength(1);
  });
});

describe("mismatchedBundleVersions", () => {
  it("accepts targets that agree", () => {
    expect(
      mismatchedBundleVersions("42", [
        { label: "app", bundleVersion: "42" },
        { label: "widgets", bundleVersion: "42" },
      ]),
    ).toEqual([]);
  });

  // The exact failure the EAS pipeline needed a dedicated sync step to avoid.
  it("catches an extension left behind at 1", () => {
    expect(
      mismatchedBundleVersions("42", [
        { label: "app", bundleVersion: "42" },
        { label: "widgets", bundleVersion: "1" },
      ]),
    ).toEqual(["widgets is 1, expected 42"]);
  });

  // The sharing extension resolves this at build time, so it is not yet knowable
  // and must not be reported as a mismatch.
  it("ignores an unresolved build setting reference", () => {
    expect(
      mismatchedBundleVersions("42", [
        { label: "sharing", bundleVersion: "$(CURRENT_PROJECT_VERSION)" },
      ]),
    ).toEqual([]);
  });

  it("reports every mismatch, not just the first", () => {
    expect(
      mismatchedBundleVersions("42", [
        { label: "a", bundleVersion: "1" },
        { label: "b", bundleVersion: "2" },
      ]),
    ).toHaveLength(2);
  });
});

describe("renderExportOptionsPlist", () => {
  const options = {
    teamId: "6V7XX6L5ZK",
    bundleIdentifier: "com.t3code.dev",
    appProfile: "T3 Code App Store",
    widgetsProfile: "T3 Code Widgets App Store",
    sharingProfile: "T3 Code Sharing App Store",
  };

  it("maps every embedded target to its profile", () => {
    const plist = renderExportOptionsPlist(options);
    expect(plist).toContain("<key>com.t3code.dev</key>\n\t\t<string>T3 Code App Store</string>");
    expect(plist).toContain("<key>com.t3code.dev.widgets</key>");
    expect(plist).toContain("<key>com.t3code.dev.sharing</key>");
  });

  it("targets App Store Connect with a distribution identity", () => {
    const plist = renderExportOptionsPlist(options);
    expect(plist).toContain("<string>app-store-connect</string>");
    expect(plist).toContain("<string>Apple Distribution</string>");
    expect(plist).toContain("<string>manual</string>");
  });

  // The build number came from App Store Connect before the archive; Xcode
  // managing it here would overwrite it.
  it("leaves the build number alone", () => {
    expect(renderExportOptionsPlist(options)).toContain(
      "<key>manageAppVersionAndBuildNumber</key>\n\t<false/>",
    );
  });

  it("omits the sharing extension when it is not built", () => {
    const plist = renderExportOptionsPlist({ ...options, sharingProfile: undefined });
    expect(plist).not.toContain(".sharing");
    expect(plist).toContain(".widgets");
  });

  it("escapes XML metacharacters in a profile name", () => {
    expect(renderExportOptionsPlist({ ...options, appProfile: "A & B <prod>" })).toContain(
      "<string>A &amp; B &lt;prod&gt;</string>",
    );
  });
});

describe("buildVersionsFromAscResponse", () => {
  it("collects build versions", () => {
    expect(
      buildVersionsFromAscResponse({
        data: [{ attributes: { version: "41" } }, { attributes: { version: "42" } }],
      }),
    ).toEqual(["41", "42"]);
  });

  it("survives an empty or malformed page", () => {
    expect(buildVersionsFromAscResponse({})).toEqual([]);
    expect(buildVersionsFromAscResponse({ data: [{}, { attributes: {} }] })).toEqual([]);
  });
});
