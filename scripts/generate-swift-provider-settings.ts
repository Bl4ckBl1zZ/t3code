// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/** The native account form consumes the same labels, fields and defaults as web. */
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { PROVIDER_SETTINGS_DEFINITIONS } from "../apps/web/src/components/settings/providerSettingsDefinitions.ts";
import { deriveProviderSettingsFields } from "../apps/web/src/components/settings/providerSettingsFields.ts";
const path = NodeURL.fileURLToPath(
  new URL("../apps/swift-ios/Resources/ProviderSettingsCatalog.json", import.meta.url),
);
const definitions = PROVIDER_SETTINGS_DEFINITIONS.map((definition) => ({
  driver: definition.value,
  label: definition.label,
  hasDefaultInstance: definition.hasDefaultInstance !== false,
  ...(definition.defaultInstance ? { defaultInstance: definition.defaultInstance } : {}),
  ...(definition.badgeLabel ? { badgeLabel: definition.badgeLabel } : {}),
  environmentFields: definition.environmentFields ?? [],
  fields: deriveProviderSettingsFields(definition),
}));
const output = JSON.stringify(definitions, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (NodeFS.readFileSync(path, "utf8") !== output)
    throw new Error(
      "Native provider forms are stale. Run node scripts/generate-swift-provider-settings.ts",
    );
} else NodeFS.writeFileSync(path, output);
