import type {
  ModelCapabilities,
  ModelSelection,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly isDefault: boolean;
  readonly isLegacy: boolean;
  readonly capabilities: ModelCapabilities | null;
  readonly selection: ModelSelection;
};

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly models: ReadonlyArray<ModelOption>;
};

function providerDisplayLabel(provider: {
  readonly displayName?: string | undefined;
  readonly driver: string;
  readonly instanceId: string;
}): string {
  if (provider.displayName) return provider.displayName;
  if (provider.driver === "codex") return "Codex";
  if (provider.driver === "claudeAgent") return "Claude";
  return provider.instanceId;
}

function normalizeSelectionOptions(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
): ModelSelection {
  if (!capabilities) {
    return selection;
  }
  const options = buildProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }),
  );
  return options
    ? { ...selection, options }
    : {
        instanceId: selection.instanceId,
        model: selection.model,
      };
}

/**
 * A stored model selection is only usable when its provider instance is
 * currently enabled, installed, and authenticated on the server. Returns the
 * selection unchanged when usable, otherwise `null` so callers fall through to
 * the server's default model. A missing config (environment offline) cannot be
 * validated, so stored selections pass through untouched.
 */
export function resolveSelectableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  if (!selection || !config) {
    return selection;
  }
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  return provider &&
    provider.enabled &&
    provider.installed &&
    provider.auth.status !== "unauthenticated"
    ? selection
    : null;
}

/**
 * Like resolveSelectableModelSelection, but additionally rejects legacy
 * models. Used for implicit defaults (stored draft, project last-used): a
 * new thread should never quietly start on a legacy model, so those fall
 * through to the provider's default instead. Explicit picks in the settings
 * sheet are unaffected.
 */
export function resolveDefaultableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  const usable = resolveSelectableModelSelection(config, selection);
  if (!usable || !config) {
    return usable;
  }
  const provider = config.providers.find((candidate) => candidate.instanceId === usable.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === usable.model);
  return model?.isLegacy === true ? null : usable;
}

/**
 * Which providers a picker may offer. Hermes is the T3 Work assistant and the
 * only thing T3 Work runs on, and it is not a coding provider — so a T3 Work
 * picker lists Hermes and nothing else, and a Code picker lists everything
 * else. "all" is for surfaces that are neither, such as automations.
 */
export type ModelOptionProviderScope = "all" | "hermes-only" | "exclude-hermes";

function matchesProviderScope(driver: string, scope: ModelOptionProviderScope): boolean {
  if (scope === "all") return true;
  return scope === "hermes-only" ? driver === "hermes" : driver !== "hermes";
}

/**
 * Applies the user's model visibility and ordering for one provider instance,
 * mirroring `applyInstanceModelPreferences` in `apps/web/src/modelSelection.ts`.
 *
 * Custom models are never hidden — the web settings editor omits the hide
 * toggle for them, so a hand-typed slug can only be removed by deleting it.
 */
function applyModelPreferences<T extends { readonly slug: string; readonly isCustom?: boolean }>(
  models: ReadonlyArray<T>,
  preferences:
    | { readonly hiddenModels: ReadonlyArray<string>; readonly modelOrder: ReadonlyArray<string> }
    | undefined,
): ReadonlyArray<T> {
  if (!preferences) return models;

  const hidden = new Set(preferences.hiddenModels);
  const visible = models.filter((model) => model.isCustom === true || !hidden.has(model.slug));
  if (preferences.modelOrder.length === 0) return visible;

  // Ordered slugs first, everything else keeping its catalog position behind
  // them. `Array.prototype.sort` is stable, so equal ranks preserve order.
  const rankBySlug = new Map(preferences.modelOrder.map((slug, index) => [slug, index] as const));
  return [...visible].sort((left, right) => {
    // Subtracting the ranks would yield NaN for two unordered models, which
    // silently scrambles the comparator.
    const leftRank = rankBySlug.get(left.slug) ?? Number.POSITIVE_INFINITY;
    const rightRank = rankBySlug.get(right.slug) ?? Number.POSITIVE_INFINITY;
    if (leftRank === rightRank) return 0;
    return leftRank < rightRank ? -1 : 1;
  });
}

export function buildModelOptions(
  config: T3ServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
  providerScope: ModelOptionProviderScope = "all",
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();

  for (const provider of config?.providers ?? []) {
    if (!provider.enabled || !provider.installed || provider.auth.status === "unauthenticated") {
      continue;
    }
    if (!matchesProviderScope(provider.driver, providerScope)) {
      continue;
    }

    const providerLabel = providerDisplayLabel(provider);
    const visibleModels = applyModelPreferences(
      provider.models,
      // Optional all the way down: a server that predates the setting sends no
      // `providerModelPreferences`, and callers hand us partial configs.
      config?.settings?.providerModelPreferences?.[provider.instanceId],
    );
    for (const model of visibleModels) {
      const key = `${provider.instanceId}:${model.slug}`;
      options.set(key, {
        key,
        label: model.name,
        subtitle: providerLabel,
        providerKey: provider.instanceId,
        providerLabel,
        providerDriver: provider.driver,
        isDefault: model.isDefault === true,
        isLegacy: model.isLegacy === true,
        capabilities: model.capabilities,
        selection: normalizeSelectionOptions(
          {
            instanceId: provider.instanceId,
            model: model.slug,
          },
          model.capabilities,
        ),
      });
    }
  }

  if (fallbackModelSelection) {
    const key = `${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`;
    const existing = options.get(key);
    if (existing) {
      options.set(key, {
        ...existing,
        selection: normalizeSelectionOptions(fallbackModelSelection, existing.capabilities),
      });
    } else {
      const providerLabel = fallbackModelSelection.instanceId;
      options.set(key, {
        key,
        label: fallbackModelSelection.model,
        subtitle: providerLabel,
        providerKey: fallbackModelSelection.instanceId,
        providerLabel,
        providerDriver: fallbackModelSelection.instanceId,
        isDefault: false,
        isLegacy: false,
        capabilities: null,
        selection: fallbackModelSelection,
      });
    }
  }

  return [...options.values()];
}

export function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup> {
  const groups = new Map<string, { providerLabel: string; models: ModelOption[] }>();
  for (const option of options) {
    const existing = groups.get(option.providerKey);
    if (existing) {
      existing.models.push(option);
    } else {
      groups.set(option.providerKey, {
        providerLabel: option.providerLabel,
        models: [option],
      });
    }
  }

  return [...groups.entries()].map(([providerKey, group]) => ({
    providerKey,
    providerLabel: group.providerLabel,
    models: group.models,
  }));
}
