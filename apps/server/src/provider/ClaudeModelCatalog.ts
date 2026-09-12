import {
  type CustomModelSetting,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  readCustomModelEntries,
} from "@t3tools/shared/model";
import { buildSelectOptionDescriptor } from "./providerSnapshot.ts";
import { compareSemverVersions } from "@t3tools/shared/semver";

import {
  type ClaudeCodeCompatibility,
  type ClaudeCodeProfile,
  decodeClaudeModelAdapter,
  decodeClaudeProfileAdapter,
} from "./ClaudeModelManifest.ts";
import {
  BUNDLED_MODEL_MANIFEST,
  type ModelManifestData,
  resolveProviderCatalog,
} from "./ModelManifest.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const EMPTY_CAPABILITIES: ModelCapabilities = { optionDescriptors: [] };

export interface ClaudeCatalogModel {
  readonly model: ServerProviderModel;
  readonly runtime: ClaudeCodeProfile;
  readonly compatibility: ClaudeCodeCompatibility;
}

export interface ClaudeModelCatalog {
  readonly models: ReadonlyArray<ClaudeCatalogModel>;
}

const CLAUDE_AUTO_COMPACT_CHOICES = [
  { value: "250k", label: "250K", tokens: 250_000, isDefault: false },
  { value: "500k", label: "500K", tokens: 500_000, isDefault: false },
  { value: "750k", label: "750K", tokens: 750_000, isDefault: false },
  { value: "1m", label: "1M", tokens: 1_000_000, isDefault: true },
] as const;

export const CLAUDE_AUTO_COMPACT_OPTION_ID = "autoCompactWindow";

/** The top stop means "no cap of ours"; the adapter sends nothing for it. */
const CLAUDE_AUTO_COMPACT_UNCAPPED_TOKENS = 1_000_000;

function buildClaudeAutoCompactDescriptor() {
  return buildSelectOptionDescriptor({
    id: CLAUDE_AUTO_COMPACT_OPTION_ID,
    label: "Context",
    description:
      "Claude summarizes the conversation once it passes this much context. The model's own window stays at 1M.",
    presentation: "slider",
    options: CLAUDE_AUTO_COMPACT_CHOICES.map((choice) => ({
      value: choice.value,
      label: choice.label,
      ...(choice.isDefault ? { isDefault: true } : {}),
    })),
  });
}

// These models have a native 1M window; retain their bare SDK identifiers.
const NATIVE_1M_MODELS = new Set([
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
]);

function maximumContextTokens(runtime: ClaudeCodeProfile): number | undefined {
  const values = Object.values(runtime.contextWindowTokens ?? {}).filter(
    (value) => Number.isFinite(value) && value > 0,
  );
  return runtime.fixedContextWindowTokens ?? (values.length ? Math.max(...values) : undefined);
}

function withCompactionControl(
  model: ServerProviderModel,
  runtime: ClaudeCodeProfile,
): ServerProviderModel {
  const descriptors = (model.capabilities?.optionDescriptors ?? []).filter(
    (descriptor) =>
      descriptor.id !== "contextWindow" && descriptor.id !== CLAUDE_AUTO_COMPACT_OPTION_ID,
  );
  return {
    ...model,
    capabilities: {
      ...model.capabilities,
      optionDescriptors: [
        ...descriptors,
        ...((maximumContextTokens(runtime) ?? 0) >= 1_000_000
          ? [buildClaudeAutoCompactDescriptor()]
          : []),
      ],
    },
  };
}

export function resolveClaudeCatalogAutoCompactTokens(
  catalog: ClaudeModelCatalog,
  selection: ModelSelection,
): number | undefined {
  const raw = getModelSelectionStringOptionValue(selection, CLAUDE_AUTO_COMPACT_OPTION_ID);
  const descriptors = getProviderOptionDescriptors({
    caps: getClaudeCatalogModelCapabilities(catalog, selection.model),
    ...(raw ? { selections: [{ id: CLAUDE_AUTO_COMPACT_OPTION_ID, value: raw }] } : {}),
  });
  const value = getProviderOptionCurrentValue(
    descriptors.find((option) => option.id === CLAUDE_AUTO_COMPACT_OPTION_ID),
  );
  const tokens = CLAUDE_AUTO_COMPACT_CHOICES.find((choice) => choice.value === value)?.tokens;
  return tokens === undefined || tokens >= CLAUDE_AUTO_COMPACT_UNCAPPED_TOKENS ? undefined : tokens;
}

function tryResolveClaudeModelCatalog(manifest: ModelManifestData): ClaudeModelCatalog | null {
  const resolved = resolveProviderCatalog(manifest, CLAUDE);
  if (!resolved) return null;

  const models: Array<ClaudeCatalogModel> = [];
  for (const entry of resolved.models) {
    const profile = decodeClaudeProfileAdapter(entry.profileAdapter ?? {});
    const adapter = decodeClaudeModelAdapter(entry.adapter ?? {});
    if (Option.isNone(profile) || Option.isNone(adapter)) return null;
    models.push({
      model: withCompactionControl(entry.model, profile.value.claudeCode ?? {}),
      runtime: profile.value.claudeCode ?? {},
      compatibility: adapter.value.claudeCode ?? {},
    });
  }

  return {
    models,
  };
}

export function resolveClaudeModelCatalog(manifest: ModelManifestData): ClaudeModelCatalog {
  return (
    tryResolveClaudeModelCatalog(manifest) ??
    tryResolveClaudeModelCatalog(BUNDLED_MODEL_MANIFEST) ?? {
      models: [],
    }
  );
}

export const BUNDLED_CLAUDE_MODEL_CATALOG = resolveClaudeModelCatalog(BUNDLED_MODEL_MANIFEST);

/**
 * Scope the catalog to one instance's settings: custom model slugs stay opaque
 * (a built-in alias they shadow is dropped, canonical slugs and capabilities
 * are preserved), and custom entries that declare their own capabilities are
 * appended so the adapter resolves effort / fast mode / thinking against the
 * user's descriptors instead of the empty default. Custom entries carry no
 * runtime profile, so option values pass through to Claude Code verbatim.
 */
export function scopeClaudeModelCatalog(
  catalog: ClaudeModelCatalog,
  customModels: ReadonlyArray<CustomModelSetting>,
): ClaudeModelCatalog {
  const customEntries = readCustomModelEntries(customModels);
  if (customEntries.length === 0) return catalog;
  const customAliases = new Set(customEntries.map((entry) => entry.slug.toLowerCase()));

  const builtInModels = catalog.models.map((entry) => {
    if (!entry.model.aliases?.some((alias) => customAliases.has(alias.toLowerCase()))) {
      return entry;
    }
    return {
      ...entry,
      model: {
        ...entry.model,
        aliases: entry.model.aliases.filter((alias) => !customAliases.has(alias.toLowerCase())),
      },
    };
  });
  const builtInSlugs = new Set(builtInModels.map((entry) => entry.model.slug));
  const customCatalogModels: Array<ClaudeCatalogModel> = [];
  for (const entry of customEntries) {
    if (!entry.capabilities || builtInSlugs.has(entry.slug)) continue;
    customCatalogModels.push({
      model: {
        slug: entry.slug,
        name: entry.name,
        isCustom: true,
        capabilities: entry.capabilities,
      },
      runtime: {},
      compatibility: {},
    });
  }

  return { models: [...builtInModels, ...customCatalogModels] };
}

function resolveClaudeCatalogModel(
  catalog: ClaudeModelCatalog,
  slugOrAlias: string | null | undefined,
): ClaudeCatalogModel | undefined {
  const value = slugOrAlias?.trim();
  if (!value) return undefined;
  return (
    catalog.models.find((entry) => entry.model.slug === value) ??
    catalog.models.find((entry) =>
      entry.model.aliases?.some((alias) => alias.toLowerCase() === value.toLowerCase()),
    )
  );
}

export function resolveClaudeModelSlug(catalog: ClaudeModelCatalog, slugOrAlias: string): string {
  return resolveClaudeCatalogModel(catalog, slugOrAlias)?.model.slug ?? slugOrAlias;
}

export function getClaudeCatalogModelCapabilities(
  catalog: ClaudeModelCatalog,
  slugOrAlias: string | null | undefined,
): ModelCapabilities {
  return resolveClaudeCatalogModel(catalog, slugOrAlias)?.model.capabilities ?? EMPTY_CAPABILITIES;
}

function isVersionSupported(
  compatibility: ClaudeCodeCompatibility,
  version: string | null | undefined,
): boolean {
  if (!compatibility.minVersion && !compatibility.maxVersionExclusive) return true;
  if (!version) return false;
  if (compatibility.minVersion && compareSemverVersions(version, compatibility.minVersion) < 0) {
    return false;
  }
  return !(
    compatibility.maxVersionExclusive &&
    compareSemverVersions(version, compatibility.maxVersionExclusive) >= 0
  );
}

export function resolveClaudeModelsForVersion(
  catalog: ClaudeModelCatalog,
  version: string | null | undefined,
): ReadonlyArray<ClaudeCatalogModel["model"]> {
  return catalog.models
    .filter((entry) => isVersionSupported(entry.compatibility, version))
    .map((entry) => entry.model);
}

export function formatClaudeVersionUpgradeMessage(
  catalog: ClaudeModelCatalog,
  version: string | null,
): string | undefined {
  const unavailable = catalog.models
    .filter(
      (entry) =>
        entry.compatibility.minVersion &&
        (!version || compareSemverVersions(version, entry.compatibility.minVersion) < 0),
    )
    .toSorted((left, right) =>
      compareSemverVersions(left.compatibility.minVersion!, right.compatibility.minVersion!),
    )[0];
  if (!unavailable?.compatibility.minVersion) return undefined;
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for ${unavailable.model.name}. Upgrade to v${unavailable.compatibility.minVersion} or newer to access it.`;
}

export function resolveClaudeCatalogEffort(
  catalog: ClaudeModelCatalog,
  model: string | null | undefined,
  raw: string | null | undefined,
): string | undefined {
  const caps = getClaudeCatalogModelCapabilities(catalog, model);
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "effort");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function normalizeClaudeCatalogEffort(
  catalog: ClaudeModelCatalog,
  effort: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!effort) return undefined;
  const effortMap = resolveClaudeCatalogModel(catalog, model)?.runtime.effortMap;
  if (!effortMap || !Object.prototype.hasOwnProperty.call(effortMap, effort)) return effort;
  return effortMap[effort] ?? undefined;
}

export function isClaudeCatalogUltracodeEffort(effort: string | null | undefined): boolean {
  return effort === "ultracode";
}

export function resolveClaudeCatalogApiModelId(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection,
): string {
  const entry = resolveClaudeCatalogModel(catalog, modelSelection.model);
  const slug = entry?.model.slug ?? modelSelection.model;
  const descriptors = getProviderOptionDescriptors({
    caps: entry?.model.capabilities ?? EMPTY_CAPABILITIES,
    selections: modelSelection.options,
  });
  for (const [optionId, suffixes] of Object.entries(entry?.runtime.modelSuffixes ?? {})) {
    if (optionId === "contextWindow") {
      if (NATIVE_1M_MODELS.has(slug)) continue;
      const windows = Object.entries(entry?.runtime.contextWindowTokens ?? {}).toSorted(
        (a, b) => b[1] - a[1],
      );
      const largest = windows[0]?.[0];
      if (largest && suffixes[largest]) return `${slug}${suffixes[largest]}`;
      continue;
    }
    const value = getProviderOptionCurrentValue(
      descriptors.find((descriptor) => descriptor.id === optionId),
    );
    if (typeof value === "string" && suffixes[value]) return `${slug}${suffixes[value]}`;
  }
  return slug;
}

export function resolveClaudeCatalogContextWindowTokens(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection | undefined,
): number | undefined {
  const entry = resolveClaudeCatalogModel(catalog, modelSelection?.model);
  if (!entry) return undefined;
  return maximumContextTokens(entry.runtime);
}
