// @effect-diagnostics nodeBuiltinImport:off - Release tooling runs from plain node before an Effect runtime exists.
/**
 * The parts of the direct-to-TestFlight iOS release that are easier to get right
 * in JavaScript than in bash. Driven by `apps/mobile/scripts/ios-testflight.sh`.
 *
 *   identity        Resolve team, bundle id, App Group, profile names and the
 *                   next build number, as shell assignments to `eval`.
 *   check-config    Fail if the resolved Expo config is missing values that the
 *                   EAS hosted environment used to supply.
 *   check-build-number  Fail if the generated targets disagree on CFBundleVersion.
 *   export-options  Write the ExportOptions.plist for `xcodebuild -exportArchive`.
 *
 * `identity` exists because the alternative — a pile of `T3CODE_IOS_*` repository
 * variables kept in sync by hand with what Apple actually issued — is what the
 * EAS pipeline did, and a drifted value there fails late, during signing, with
 * an unhelpful message. The provisioning profile is the source of truth.
 */
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import {
  buildVersionsFromAscResponse,
  createAscToken,
  missingAppConfigValues,
  mismatchedBundleVersions,
  nextBuildNumber,
  parseProvisioningProfile,
  renderExportOptionsPlist,
  type ProvisioningProfile,
  type ResolvedAppConfig,
} from "./lib/ios-release.ts";

const ASC_API_BASE = "https://api.appstoreconnect.apple.com/v1";
/** One page is plenty: this app has far fewer than 200 builds, ever. */
const ASC_BUILD_PAGE_LIMIT = 200;
const PROFILE_EXPIRY_WARNING_DAYS = 30;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function fetchNextBuildNumber(): Promise<number> {
  const token = createAscToken({
    keyId: requireEnv("ASC_API_KEY_ID"),
    issuerId: requireEnv("ASC_API_ISSUER_ID"),
    privateKeyPem: NodeFS.readFileSync(requireEnv("ASC_API_KEY_PATH"), "utf8"),
    issuedAt: Math.floor(Date.now() / 1000),
  });
  const url = new URL(`${ASC_API_BASE}/builds`);
  url.searchParams.set("filter[app]", requireEnv("ASC_APP_ID"));
  url.searchParams.set("limit", String(ASC_BUILD_PAGE_LIMIT));
  url.searchParams.set("sort", "-uploadedDate");
  url.searchParams.set("fields[builds]", "version");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!response.ok) {
    // Guessing a build number wastes an entire archive: the upload is rejected
    // at the very end, after the expensive part.
    throw new Error(
      `App Store Connect returned ${response.status} listing builds. ` +
        `Pass --build-number to override. Body: ${(await response.text()).slice(0, 400)}`,
    );
  }
  return nextBuildNumber(buildVersionsFromAscResponse(await response.json()));
}

function readProfile(path: string): ProvisioningProfile {
  const profile = parseProvisioningProfile(NodeFS.readFileSync(path));
  if (profile.expiresAt !== undefined) {
    const daysLeft = (profile.expiresAt.getTime() - Date.now()) / 86_400_000;
    if (daysLeft <= 0) {
      throw new Error(
        `Provisioning profile "${profile.name}" expired on ${profile.expiresAt.toISOString()}.`,
      );
    }
    if (daysLeft < PROFILE_EXPIRY_WARNING_DAYS) {
      process.stderr.write(
        `warning: provisioning profile "${profile.name}" expires in ${Math.floor(daysLeft)} days.\n`,
      );
    }
  }
  return profile;
}

const shellAssignment = (name: string, value: string): string => `${name}=${JSON.stringify(value)}`;

async function identityCommand(argv: ReadonlyArray<string>): Promise<string> {
  const { values } = NodeUtil.parseArgs({
    args: [...argv],
    options: {
      app: { type: "string" },
      widgets: { type: "string" },
      sharing: { type: "string" },
      "build-number": { type: "string" },
    },
  });
  if (!values.app || !values.widgets) {
    throw new Error("--app and --widgets provisioning profiles are required.");
  }

  const app = readProfile(values.app);
  const widgets = readProfile(values.widgets);
  const sharing = values.sharing === undefined ? null : readProfile(values.sharing);

  for (const profile of [widgets, ...(sharing ? [sharing] : [])]) {
    if (profile.teamId !== app.teamId) {
      throw new Error(
        `Profile "${profile.name}" belongs to team ${profile.teamId}, not ${app.teamId}.`,
      );
    }
    if (!profile.bundleIdentifier.startsWith(`${app.bundleIdentifier}.`)) {
      throw new Error(
        `Profile "${profile.name}" targets ${profile.bundleIdentifier}, which is not an extension of ${app.bundleIdentifier}.`,
      );
    }
  }
  if (app.appGroupIdentifier === undefined) {
    throw new Error(
      `Provisioning profile "${app.name}" grants no App Group; the widget and sharing extensions need one.`,
    );
  }

  const buildNumber =
    values["build-number"] === undefined
      ? await fetchNextBuildNumber()
      : Number.parseInt(values["build-number"], 10);
  if (!Number.isInteger(buildNumber) || buildNumber < 1) {
    throw new Error(`Invalid build number: ${values["build-number"]}`);
  }

  return [
    shellAssignment("T3CODE_IOS_APPLE_TEAM_ID", app.teamId),
    shellAssignment("T3CODE_IOS_BUNDLE_ID", app.bundleIdentifier),
    shellAssignment("T3CODE_IOS_APP_GROUP_ID", app.appGroupIdentifier),
    shellAssignment("T3CODE_IOS_BUILD_NUMBER", String(buildNumber)),
    shellAssignment("T3CODE_IOS_PROVISIONING_PROFILE", app.name),
    shellAssignment("T3CODE_IOS_WIDGETS_PROVISIONING_PROFILE", widgets.name),
    shellAssignment("T3CODE_IOS_SHARING_EXTENSION", sharing ? "1" : "0"),
    ...(sharing ? [shellAssignment("T3CODE_IOS_SHARING_PROVISIONING_PROFILE", sharing.name)] : []),
    shellAssignment("T3CODE_IOS_PROFILE_UUID_APP", app.uuid),
    shellAssignment("T3CODE_IOS_PROFILE_UUID_WIDGETS", widgets.uuid),
    ...(sharing ? [shellAssignment("T3CODE_IOS_PROFILE_UUID_SHARING", sharing.uuid)] : []),
  ].join("\n");
}

function checkConfigCommand(argv: ReadonlyArray<string>): string {
  const [rawConfig] = argv;
  if (rawConfig === undefined) throw new Error("check-config expects the `expo config` JSON.");
  let config: ResolvedAppConfig & { readonly name?: string; readonly ios?: unknown };
  try {
    config = JSON.parse(rawConfig);
  } catch {
    throw new Error("Could not parse `expo config --json` output.");
  }
  const missing = missingAppConfigValues(config);
  if (missing.length > 0) {
    throw new Error(`The resolved app config is missing: ${missing.join(", ")}.`);
  }
  const bundleIdentifier = (config.ios as { bundleIdentifier?: string } | undefined)
    ?.bundleIdentifier;
  return `Config OK for ${config.name} (${bundleIdentifier}).`;
}

function checkBuildNumberCommand(argv: ReadonlyArray<string>): string {
  const [buildNumber, ...plistPaths] = argv;
  if (buildNumber === undefined || plistPaths.length === 0) {
    throw new Error("check-build-number expects a build number and at least one Info.plist.");
  }
  const entries = plistPaths.flatMap((path) => {
    if (!NodeFS.existsSync(path)) return [];
    const contents = NodeFS.readFileSync(path, "utf8");
    const bundleVersion = /<key>CFBundleVersion<\/key>\s*<string>([\s\S]*?)<\/string>/u.exec(
      contents,
    )?.[1];
    return bundleVersion === undefined ? [] : [{ label: path, bundleVersion }];
  });
  if (entries.length === 0) throw new Error("No Info.plist declared a CFBundleVersion.");
  const mismatches = mismatchedBundleVersions(buildNumber, entries);
  if (mismatches.length > 0) {
    throw new Error(`Build number mismatch: ${mismatches.join("; ")}.`);
  }
  return `Build number ${buildNumber} is consistent across ${entries.length} targets.`;
}

function exportOptionsCommand(argv: ReadonlyArray<string>): string {
  const [outputPath] = argv;
  if (outputPath === undefined) throw new Error("export-options expects an output path.");
  NodeFS.writeFileSync(
    outputPath,
    renderExportOptionsPlist({
      teamId: requireEnv("T3CODE_IOS_APPLE_TEAM_ID"),
      bundleIdentifier: requireEnv("T3CODE_IOS_BUNDLE_ID"),
      appProfile: requireEnv("T3CODE_IOS_PROVISIONING_PROFILE"),
      widgetsProfile: requireEnv("T3CODE_IOS_WIDGETS_PROVISIONING_PROFILE"),
      sharingProfile: process.env.T3CODE_IOS_SHARING_PROVISIONING_PROFILE?.trim() || undefined,
    }),
  );
  return `Wrote ${outputPath}.`;
}

export async function main(argv: ReadonlyArray<string>): Promise<string> {
  const [command, ...rest] = argv;
  switch (command) {
    case "identity":
      return await identityCommand(rest);
    case "check-config":
      return checkConfigCommand(rest);
    case "check-build-number":
      return checkBuildNumberCommand(rest);
    case "export-options":
      return exportOptionsCommand(rest);
    default:
      throw new Error(`Unknown command: ${command ?? "(none)"}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (output) => process.stdout.write(`${output}\n`),
    (cause: unknown) => {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 1;
    },
  );
}
