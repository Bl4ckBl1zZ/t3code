import type {
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";

export interface HermesProactiveDefaultMigration {
  readonly patch: ServerSettingsPatch;
  /** Instances actually rewritten, for logging what moved. */
  readonly rewrittenInstanceIds: ReadonlyArray<string>;
}

/**
 * One-time rewrite of Hermes instances that predate proactive mode shipping
 * as opt-out.
 *
 * The schema default only reaches a config blob that omits the key, and the
 * instance editor writes every field at creation time — so an instance made
 * under the old default carries `proactiveEnabled: false` explicitly, and no
 * amount of default-flipping moves it. Rewriting it once is the only way the
 * new behavior reaches an existing install.
 *
 * Deliberately narrow: it touches Hermes instances only, only flips false to
 * true, and never runs twice. Turning the switch back off afterwards is a
 * decision the next boot must respect, which is what the persisted marker is
 * for — not an optimization.
 *
 * Returns `null` once the marker is set, so a settled install writes no
 * settings file on boot.
 */
export function hermesProactiveDefaultMigration(
  settings: ServerSettings,
): HermesProactiveDefaultMigration | null {
  if (settings.hermesProactiveDefaultApplied) return null;

  const rewritten: Record<ProviderInstanceId, ProviderInstanceConfig> = {};
  const rewrittenInstanceIds: Array<string> = [];
  for (const [rawInstanceId, instance] of Object.entries(settings.providerInstances)) {
    const instanceId = rawInstanceId as ProviderInstanceId;
    const config =
      instance.driver === "hermes" &&
      typeof instance.config === "object" &&
      instance.config !== null &&
      !Array.isArray(instance.config)
        ? (instance.config as Record<string, unknown>)
        : null;
    if (config === null || config["proactiveEnabled"] !== false) {
      rewritten[instanceId] = instance;
      continue;
    }
    rewrittenInstanceIds.push(instanceId);
    rewritten[instanceId] = { ...instance, config: { ...config, proactiveEnabled: true } };
  }

  // The marker is recorded even with nothing to rewrite: a fresh install has
  // no instances yet, and one created later already gets the new default.
  return {
    patch:
      rewrittenInstanceIds.length > 0
        ? { hermesProactiveDefaultApplied: true, providerInstances: rewritten }
        : { hermesProactiveDefaultApplied: true },
    rewrittenInstanceIds,
  };
}
