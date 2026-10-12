import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  isProviderDriverKind,
  isProviderAvailable,
  resolveProviderInstanceEnabled,
  isProviderTextGenerationCapable,
  type ModelSelection,
  type ProjectId,
  type ProjectProviderInstanceOverride,
  ProviderDriverKind,
  ProviderInstanceId,
  type PullRequestMergeMethod,
  type ServerProvider,
  ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection } from "./model.ts";
import {
  getBackgroundActivityBaseProfile,
  normalizeBackgroundActivitySettings,
  normalizeServerBackgroundActivitySettings,
  resolveBackgroundActivitySettings,
} from "./backgroundActivitySettings.ts";

export function resolveProjectAgentBrowserAccess(
  settings: Pick<ServerSettings, "enableAgentBrowserAccess" | "projectAgentBrowserAccessOverrides">,
  projectId: ProjectId,
): boolean {
  return (
    settings.projectAgentBrowserAccessOverrides[projectId] ?? settings.enableAgentBrowserAccess
  );
}

/** Explicit project choices override the environment default; null patches restore inheritance. */
export function resolveProjectAutoPull(
  settings: Pick<ServerSettings, "defaultAutoPull" | "projectAutoPullOverrides">,
  projectId: ProjectId,
): boolean {
  return settings.projectAutoPullOverrides[projectId] ?? settings.defaultAutoPull;
}

/** A project's merge method, then the machine's; `null` means the client's last choice. */
export function resolveProjectPullRequestMergeMethod(
  settings: Pick<
    ServerSettings,
    "pullRequestMergeMethod" | "projectPullRequestMergeMethodOverrides"
  >,
  projectId: ProjectId,
): PullRequestMergeMethod | null {
  return (
    settings.projectPullRequestMergeMethodOverrides[projectId] ?? settings.pullRequestMergeMethod
  );
}

/** Whether a GitHub merge in this project drops agent credits from its message. */
export function resolveProjectRemoveAgentCreditsOnMerge(
  settings: Pick<
    ServerSettings,
    "removeAgentCreditsOnMerge" | "projectRemoveAgentCreditsOnMergeOverrides"
  >,
  projectId: ProjectId,
): boolean {
  return (
    settings.projectRemoveAgentCreditsOnMergeOverrides[projectId] ??
    settings.removeAgentCreditsOnMerge
  );
}

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownOption(ServerSettingsJson);

type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];

const getLegacyProviderSettings = (
  settings: Pick<ServerSettings, "providers">,
  provider: ProviderDriverKind,
): LegacyProviderSettings | undefined =>
  (settings.providers as Record<string, LegacyProviderSettings | undefined>)[provider];

export function isModelSelectionProviderEnabled(
  settings: Pick<ServerSettings, "providerInstances" | "providers">,
  selection: Pick<ModelSelection, "instanceId">,
): boolean {
  const instanceConfig = Object.hasOwn(settings.providerInstances, selection.instanceId)
    ? settings.providerInstances[selection.instanceId]
    : undefined;
  if (instanceConfig !== undefined) {
    return resolveProviderInstanceEnabled(instanceConfig);
  }

  return (
    isProviderDriverKind(selection.instanceId) &&
    getLegacyProviderSettings(settings, selection.instanceId)?.enabled === true
  );
}

type ProjectProviderSettings = Pick<
  ServerSettings,
  "providerInstances" | "providers" | "projectProviderInstanceOverrides"
>;

/** A project's own switch for an instance; `undefined` inherits the machine. */
export function projectProviderInstanceOverride(
  settings: Pick<ServerSettings, "projectProviderInstanceOverrides">,
  projectId: ProjectId | null,
  instanceId: ProviderInstanceId,
): ProjectProviderInstanceOverride["enabled"] {
  if (projectId === null) return undefined;
  const overrides = settings.projectProviderInstanceOverrides[projectId];
  return overrides !== undefined && Object.hasOwn(overrides, instanceId)
    ? overrides[instanceId]?.enabled
    : undefined;
}

/**
 * Effective enablement for a provider instance within a project: the project's override when
 * set, in either direction, otherwise the machine's. `null` (no project in scope) always
 * resolves to the machine value.
 */
export function resolveProjectProviderInstanceEnabled(
  settings: ProjectProviderSettings,
  projectId: ProjectId | null,
  instanceId: ProviderInstanceId,
): boolean {
  return (
    projectProviderInstanceOverride(settings, projectId, instanceId) ??
    isModelSelectionProviderEnabled(settings, { instanceId })
  );
}

/**
 * The text generation model a project runs: the machine's, unless the project turned its
 * instance off. Then the first built-in default instance, then configured instance, that the
 * project leaves on, so text generation never runs on an instance the project turned off.
 */
export function resolveProjectTextGenerationModelSelection(
  settings: ProjectProviderSettings & Pick<ServerSettings, "textGenerationModelSelection">,
  projectId: ProjectId | null,
): ModelSelection {
  const selection = settings.textGenerationModelSelection;
  // Outside a project the server already resolved the machine's own fallback.
  if (
    projectId === null ||
    resolveProjectProviderInstanceEnabled(settings, projectId, selection.instanceId)
  ) {
    return selection;
  }
  const drivers = Object.keys(settings.providers).map((driver) => ProviderDriverKind.make(driver));
  const candidates = [
    ...drivers.map((driver) => [defaultInstanceIdForDriver(driver), driver] as const),
    ...Object.entries(settings.providerInstances).flatMap(([instanceId, instance]) =>
      drivers.includes(instance.driver)
        ? [[ProviderInstanceId.make(instanceId), instance.driver] as const]
        : [],
    ),
  ];
  const match = candidates.find(([instanceId]) =>
    resolveProjectProviderInstanceEnabled(settings, projectId, instanceId),
  );
  if (match === undefined) return selection;
  const [instanceId, driver] = match;
  return {
    instanceId,
    model:
      DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[driver] ??
      DEFAULT_MODEL_BY_PROVIDER[driver] ??
      DEFAULT_TEXT_GENERATION_MODEL,
  };
}

/**
 * `projectId` has no default: a caller that forgot it would silently ignore a project that
 * turned the writer's instance off. Pass `null` explicitly outside a project's scope.
 */
export function resolveSourceControlWriterModelSelection(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | undefined,
  projectId: ProjectId | null,
): ModelSelection {
  const selection = settings.sourceControlWriterModelSelection;
  const fallback = resolveProjectTextGenerationModelSelection(settings, projectId);
  if (
    !selection ||
    !resolveProjectProviderInstanceEnabled(settings, projectId, selection.instanceId)
  ) {
    return fallback;
  }
  if (providers === undefined) {
    return selection;
  }

  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  return provider?.enabled === true &&
    isProviderAvailable(provider) &&
    isProviderTextGenerationCapable(provider)
    ? selection
    : fallback;
}

/**
 * The model that writes review guides: its own setting when that provider can still run it,
 * otherwise whatever writes source control text.
 */
export function resolveReviewGuideModelSelection(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | undefined,
  projectId: ProjectId | null,
): ModelSelection {
  const selection = settings.reviewGuideModelSelection;
  if (
    selection &&
    resolveProjectProviderInstanceEnabled(settings, projectId, selection.instanceId)
  ) {
    const provider = providers?.find((candidate) => candidate.instanceId === selection.instanceId);
    if (
      providers === undefined ||
      (provider?.enabled === true &&
        isProviderAvailable(provider) &&
        isProviderTextGenerationCapable(provider))
    ) {
      return selection;
    }
  }
  return resolveSourceControlWriterModelSelection(settings, providers, projectId);
}

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

export function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  const decoded = decodeServerSettingsJson(raw);
  if (Option.isSome(decoded)) {
    return extractPersistedServerObservabilitySettings(decoded.value);
  }
  return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
}

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const {
    favorites: favoritesPatch,
    migrateModelPreferences,
    setModelFavorites,
    setModelsHidden,
    setProviderModelOrder,
    providerModelPreferences: modelPreferencesPatch,
    automaticGitFetchInterval,
    providerHealthRefreshInterval,
    backgroundActivityProfile,
    backgroundActivity,
    usagePriceOverrides: pricePatch,
    usageModelAliases: aliasPatch,
    usageLimitSources: usageSourcesPatch,
    projectScriptOverrides: scriptOverridesPatch,
    defaultProjectScripts: defaultScriptsPatch,
    projectAutoPullOverrides: autoPullPatch,
    projectAgentBrowserAccessOverrides: browserAccessPatch,
    projectPullRequestMergeMethodOverrides: mergeMethodPatch,
    projectRemoveAgentCreditsOnMergeOverrides: agentCreditsPatch,
    projectProviderInstanceOverrides: providerOverridesPatch,
    ...patchForMerge
  } = patch;
  const currentBackgroundActivity = normalizeServerBackgroundActivitySettings(current);
  const backgroundActivityPatch =
    backgroundActivityProfile !== undefined
      ? {
          schemaVersion: 1 as const,
          profile:
            automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
              ? ("custom" as const)
              : backgroundActivityProfile,
          ...(automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
            ? { baseProfile: backgroundActivityProfile }
            : {}),
          overrides: {
            ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
            ...(providerHealthRefreshInterval !== undefined
              ? { providerHealthRefreshInterval }
              : {}),
          },
        }
      : automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
        ? {
            schemaVersion: 1 as const,
            profile: "custom" as const,
            baseProfile: getBackgroundActivityBaseProfile(currentBackgroundActivity),
            overrides: {
              ...(currentBackgroundActivity.profile === "custom"
                ? currentBackgroundActivity.overrides
                : {}),
              ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
              ...(providerHealthRefreshInterval !== undefined
                ? { providerHealthRefreshInterval }
                : {}),
            },
          }
        : undefined;
  const favorites = applyModelFavoriteChanges(
    favoritesPatch ?? current.favorites ?? migrateModelPreferences?.favorites ?? null,
    setModelFavorites,
  );
  const providerModelPreferences = applyModelPreferenceChanges(
    modelPreferencesPatch ?? current.providerModelPreferences,
    setModelsHidden,
    setProviderModelOrder,
  );
  const next = deepMerge(current, patchForMerge);
  const usageLimitSources = { ...current.usageLimitSources };
  for (const [id, source] of Object.entries(usageSourcesPatch ?? {})) {
    if (source === null) delete usageLimitSources[id as keyof typeof usageLimitSources];
    else usageLimitSources[id as keyof typeof usageLimitSources] = source;
  }
  const usagePriceOverrides = { ...current.usagePriceOverrides };
  for (const [model, price] of Object.entries(pricePatch ?? {})) {
    if (price === null) delete usagePriceOverrides[model];
    else usagePriceOverrides[model] = price;
  }
  const usageModelAliases = { ...current.usageModelAliases };
  for (const [model, target] of Object.entries(aliasPatch ?? {})) {
    if (target === null) delete usageModelAliases[model];
    else usageModelAliases[model] = target;
  }
  const projectAutoPullOverrides = { ...current.projectAutoPullOverrides };
  for (const [projectId, enabled] of Object.entries(autoPullPatch ?? {})) {
    if (enabled === null) delete projectAutoPullOverrides[projectId as ProjectId];
    else projectAutoPullOverrides[projectId as ProjectId] = enabled;
  }
  const projectAgentBrowserAccessOverrides = { ...current.projectAgentBrowserAccessOverrides };
  for (const [projectId, enabled] of Object.entries(browserAccessPatch ?? {})) {
    if (enabled === null) delete projectAgentBrowserAccessOverrides[projectId as ProjectId];
    else projectAgentBrowserAccessOverrides[projectId as ProjectId] = enabled;
  }
  const projectPullRequestMergeMethodOverrides = {
    ...current.projectPullRequestMergeMethodOverrides,
  };
  for (const [projectId, method] of Object.entries(mergeMethodPatch ?? {})) {
    if (method === null) delete projectPullRequestMergeMethodOverrides[projectId as ProjectId];
    else projectPullRequestMergeMethodOverrides[projectId as ProjectId] = method;
  }
  const projectRemoveAgentCreditsOnMergeOverrides = {
    ...current.projectRemoveAgentCreditsOnMergeOverrides,
  };
  for (const [projectId, enabled] of Object.entries(agentCreditsPatch ?? {})) {
    if (enabled === null) delete projectRemoveAgentCreditsOnMergeOverrides[projectId as ProjectId];
    else projectRemoveAgentCreditsOnMergeOverrides[projectId as ProjectId] = enabled;
  }
  const projectProviderInstanceOverrides = applyProjectProviderInstanceOverrides(
    current.projectProviderInstanceOverrides,
    providerOverridesPatch,
  );
  const nextWithReplacementsBase = {
    ...next,
    usagePriceOverrides,
    usageModelAliases,
    usageLimitSources,
    defaultProjectScripts: defaultScriptsPatch ?? current.defaultProjectScripts,
    projectScriptOverrides: { ...current.projectScriptOverrides, ...scriptOverridesPatch },
    projectAutoPullOverrides,
    projectAgentBrowserAccessOverrides,
    projectPullRequestMergeMethodOverrides,
    projectRemoveAgentCreditsOnMergeOverrides,
    projectProviderInstanceOverrides,
    ...(backgroundActivity !== undefined
      ? {
          backgroundActivity: {
            ...deepMerge(currentBackgroundActivity, backgroundActivity),
            ...(backgroundActivity.overrides !== undefined
              ? { overrides: backgroundActivity.overrides }
              : {}),
          },
        }
      : { backgroundActivity: currentBackgroundActivity }),
    ...(backgroundActivity === undefined && backgroundActivityPatch !== undefined
      ? { backgroundActivity: backgroundActivityPatch }
      : {}),
    ...(patch.providerInstances !== undefined
      ? { providerInstances: patch.providerInstances }
      : {}),
    // Host replacement: deepMerge would keep a cleared account pin. Tokens merge per host.
    ...(patch.github !== undefined
      ? {
          github: {
            hosts: patch.github.hosts ?? current.github?.hosts ?? {},
            tokens: { ...current.github?.tokens, ...patch.github.tokens },
          },
        }
      : {}),
    // Remember custom worktree locations the server moved away from, so the
    // worktrees left there stay managed.
    ...(patch.worktreesDirectory !== undefined &&
    patch.worktreesDirectory !== current.worktreesDirectory
      ? {
          previousWorktreesDirectories: [
            ...current.previousWorktreesDirectories.filter(
              (directory) => directory !== patch.worktreesDirectory,
            ),
            ...(current.worktreesDirectory !== "" &&
            !current.previousWorktreesDirectories.includes(current.worktreesDirectory)
              ? [current.worktreesDirectory]
              : []),
          ],
        }
      : {}),
    // Whole-map replacement, like `providerInstances`. A deep merge would keep
    // instance keys the settings editor deleted (it drops an entry once both
    // its lists are empty) and could union the arrays, so un-hiding a model
    // would never actually un-hide it.
    providerModelPreferences,
    favorites,
    ...(patch.defaultModelSelection !== undefined
      ? { defaultModelSelection: patch.defaultModelSelection }
      : {}),
    ...(patch.sourceControlWriterModelSelection !== undefined
      ? { sourceControlWriterModelSelection: patch.sourceControlWriterModelSelection }
      : {}),
    ...(patch.reviewGuideModelSelection !== undefined
      ? { reviewGuideModelSelection: patch.reviewGuideModelSelection }
      : {}),
    ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
    ...(providerHealthRefreshInterval !== undefined ? { providerHealthRefreshInterval } : {}),
  };
  const normalizedBackgroundActivity = normalizeBackgroundActivitySettings(
    nextWithReplacementsBase.backgroundActivity,
  );
  const resolvedBackgroundActivity = resolveBackgroundActivitySettings(
    normalizedBackgroundActivity,
  );
  const nextWithReplacements = {
    ...nextWithReplacementsBase,
    backgroundActivity: normalizedBackgroundActivity,
    automaticGitFetchInterval: resolvedBackgroundActivity.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolvedBackgroundActivity.providerHealthRefreshInterval,
    backgroundActivityProfile: resolvedBackgroundActivity.profile,
  };
  if (!selectionPatch) {
    return nextWithReplacements;
  }

  const instanceId = selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : mergeModelSelectionOptionsById({
        current: current.textGenerationModelSelection.options,
        patch: selectionPatch.options,
      });

  return {
    ...nextWithReplacements,
    textGenerationModelSelection: createModelSelection(instanceId, model, options),
  };
}

/**
 * Sparse per project and per instance, so concurrent edits to other projects or instances
 * survive. A project left with no overrides drops out of the map.
 */
function applyProjectProviderInstanceOverrides(
  current: ServerSettings["projectProviderInstanceOverrides"],
  patch: ServerSettingsPatch["projectProviderInstanceOverrides"],
): ServerSettings["projectProviderInstanceOverrides"] {
  if (patch === undefined) return current;
  const next = { ...current };
  for (const [rawProjectId, instancesPatch] of Object.entries(patch)) {
    const projectId = rawProjectId as ProjectId;
    if (instancesPatch === null) {
      delete next[projectId];
      continue;
    }
    const instances = { ...next[projectId] };
    for (const [rawInstanceId, override] of Object.entries(instancesPatch)) {
      const instanceId = rawInstanceId as ProviderInstanceId;
      if (override === null || override.enabled === undefined) delete instances[instanceId];
      else instances[instanceId] = override;
    }
    if (Object.keys(instances).length === 0) delete next[projectId];
    else next[projectId] = instances;
  }
  return next;
}

type ModelFavoriteList = NonNullable<ServerSettings["favorites"]>;
type ProviderModelPreferenceMap = ServerSettings["providerModelPreferences"];

/** Idempotent per-entry favorite edits; the list stays unset until something claims it. */
function applyModelFavoriteChanges(
  initial: ModelFavoriteList | null,
  changes: ServerSettingsPatch["setModelFavorites"],
): ModelFavoriteList | null {
  if (changes === undefined) return initial;
  const favorites = [...(initial ?? [])];
  for (const change of changes) {
    const index = favorites.findIndex(
      (favorite) => favorite.provider === change.provider && favorite.model === change.model,
    );
    if (change.favorite && index === -1) {
      favorites.push({ provider: change.provider, model: change.model });
    } else if (!change.favorite && index !== -1) {
      favorites.splice(index, 1);
    }
  }
  return favorites;
}

/** Per-model visibility and per-instance order edits that leave every other entry alone. */
function applyModelPreferenceChanges(
  initial: ProviderModelPreferenceMap,
  hiddenChanges: ServerSettingsPatch["setModelsHidden"],
  orderChange: ServerSettingsPatch["setProviderModelOrder"],
): ProviderModelPreferenceMap {
  if (hiddenChanges === undefined && orderChange === undefined) return initial;
  const next: Record<ProviderInstanceId, ProviderModelPreferenceMap[ProviderInstanceId]> = {
    ...initial,
  };
  const entryFor = (provider: ProviderInstanceId) =>
    next[provider] ?? { hiddenModels: [], modelOrder: [] };
  for (const change of hiddenChanges ?? []) {
    const entry = entryFor(change.provider);
    const hiddenModels = entry.hiddenModels.filter((model) => model !== change.model);
    if (change.hidden) hiddenModels.push(change.model);
    next[change.provider] = { ...entry, hiddenModels };
  }
  if (orderChange !== undefined) {
    next[orderChange.provider] = {
      ...entryFor(orderChange.provider),
      modelOrder: [...orderChange.modelOrder],
    };
  }
  return next;
}

/**
 * Model preferences as clients read them: the environment's favorites once
 * any client has seeded them, this device's legacy list until then.
 */
export function resolveModelPreferences(
  settings: Pick<ServerSettings, "favorites" | "providerModelPreferences">,
  legacy: { readonly favorites?: ModelFavoriteList } = {},
): {
  readonly favorites: ModelFavoriteList;
  readonly providerModelPreferences: ProviderModelPreferenceMap;
} {
  return {
    favorites: settings.favorites ?? legacy.favorites ?? [],
    providerModelPreferences: settings.providerModelPreferences,
  };
}

/**
 * Seeds this device's legacy favorites while the environment has none. An
 * empty legacy list does not claim the environment, so another device can
 * still seed the list it actually holds; the server applies the seed only
 * while still unset, so a delayed seed cannot undo a later clear.
 */
export function modelPreferencesMigrationPatch(
  settings: Pick<ServerSettings, "favorites">,
  legacy: { readonly favorites?: ModelFavoriteList },
): ServerSettingsPatch | null {
  const favorites = legacy.favorites ?? [];
  return settings.favorites === null && favorites.length > 0
    ? { migrateModelPreferences: { favorites } }
    : null;
}
