import {
  ProviderInstanceId,
  ThreadId,
  type HermesGatewayCompatibility,
  type HermesGatewayCronListResult,
  type HermesProactiveProviderStatus,
  type HermesProactiveResidentThread,
  type HermesProactiveStatusResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ServerSettings from "../serverSettings.ts";
import { HermesGatewayClient } from "./HermesGatewayClient.ts";
import { HermesProactiveEventRepository } from "./HermesProactiveEventRepository.ts";
import {
  resolveHermesProviderConnections,
  type HermesProviderConnection,
} from "./HermesProviderDirectory.ts";
import { HermesSessionBindingRepository } from "./HermesSessionBindingRepository.ts";

/**
 * How often residency is re-established. Hermes releases nothing on its side;
 * this exists because T3's own session manager retires idle provider sessions,
 * and a released session has no gateway subscription to witness a cron run.
 */
export const SWEEP_INTERVAL = Duration.minutes(10);

/**
 * Upper bound on Hermes threads kept subscribed per profile when the gateway
 * does not say which session a job runs in. Without a cap, proactive mode on a
 * profile with hundreds of imported sessions would open hundreds of gateways.
 */
const MAX_RESIDENT_THREADS_PER_PROFILE = 8;

export interface HermesProactiveServiceShape {
  /**
   * Re-registers every proactive source and re-establishes residency. Safe to
   * call at any time: opening an already-open session is a no-op.
   */
  readonly sweep: () => Effect.Effect<HermesProactiveStatusResult>;
  readonly report: () => Effect.Effect<HermesProactiveStatusResult>;
}

export class HermesProactiveService extends Context.Service<
  HermesProactiveService,
  HermesProactiveServiceShape
>()("t3/hermes/HermesProactiveService") {}

interface HermesProactiveGatewayClient {
  connect(): Promise<HermesGatewayCompatibility>;
  hasCapability(capability: string): boolean;
  listCronJobs(): Promise<HermesGatewayCronListResult>;
  close(): void;
}

export interface HermesProactiveServiceOptions {
  readonly clientFactory?: (input: {
    readonly endpoint: string;
    readonly authToken: string;
  }) => HermesProactiveGatewayClient;
  /**
   * Overrides how a thread is made resident. Defaults to opening it through
   * OrchestratorV2, which is what establishes the gateway subscription.
   */
  readonly ensureResident?: (input: {
    readonly threadId: string;
    readonly providerInstanceId: string;
  }) => Effect.Effect<boolean>;
}

const EMPTY_REPORT: HermesProactiveStatusResult = { providers: [], sweptAt: null };

/**
 * The session a job runs in, when the gateway names it. The pinned protocol
 * does not require any of these fields, so an absent target is expected rather
 * than an error.
 */
export function hermesCronJobSessionKey(job: {
  readonly session_key?: string | undefined;
  readonly stored_session_id?: string | undefined;
  readonly session_id?: string | undefined;
}): string | null {
  const candidate = job.session_key ?? job.stored_session_id ?? job.session_id;
  return candidate !== undefined && candidate.trim().length > 0 ? candidate.trim() : null;
}

export function hermesCronJobIsEnabled(job: {
  readonly enabled?: boolean | undefined;
  readonly paused?: boolean | undefined;
}): boolean {
  if (job.enabled !== undefined) return job.enabled;
  if (job.paused !== undefined) return !job.paused;
  // A gateway that reports neither flag lists only live jobs.
  return true;
}

export const make = Effect.fn("HermesProactiveService.make")(function* (
  options: HermesProactiveServiceOptions = {},
) {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const proactiveRepository = yield* HermesProactiveEventRepository;
  const bindings = yield* HermesSessionBindingRepository;
  const orchestrator = yield* Effect.serviceOption(OrchestratorV2);
  const clientFactory =
    options.clientFactory ??
    ((input: { readonly endpoint: string; readonly authToken: string }) =>
      new HermesGatewayClient(input));
  const lastReport = yield* Ref.make(EMPTY_REPORT);

  const withClient = <A>(
    connection: HermesProviderConnection,
    use: (client: HermesProactiveGatewayClient) => Promise<A>,
  ) =>
    Effect.tryPromise(async () => {
      const client = clientFactory({
        endpoint: connection.endpoint,
        authToken: connection.token,
      });
      try {
        return await use(client);
      } finally {
        client.close();
      }
    });

  /**
   * Opening the provider thread is what subscribes T3 to the gateway session.
   * The snapshot hydration it performs is incidental — and idempotent, so a
   * sweep that finds everything already projected writes nothing.
   */
  const ensureResident =
    options.ensureResident ??
    Effect.fn("HermesProactiveService.ensureResident")(
      function* (input: { readonly threadId: string; readonly providerInstanceId: string }) {
        if (orchestrator._tag === "None") return false;
        yield* orchestrator.value.hydrateProviderThreadSnapshot({
          threadId: ThreadId.make(input.threadId),
          providerInstanceId: ProviderInstanceId.make(input.providerInstanceId),
        });
        return true;
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("hermes.proactive.residency-failed", { cause }).pipe(Effect.as(false)),
      ),
    );

  const sweepProvider = Effect.fn("HermesProactiveService.sweepProvider")(function* (
    connection: HermesProviderConnection,
  ) {
    const diagnostics: Array<string> = [];
    const now = DateTime.formatIso(yield* DateTime.now);
    if (!connection.settings.proactiveEnabled) {
      return {
        providerInstanceId: connection.providerInstanceId,
        displayName: connection.displayName,
        profileKey: connection.profileKey,
        enabled: false,
        source: null,
        enabledJobCount: 0,
        residentThreads: [],
        diagnostics: ["Proactive mode is disabled for this Hermes instance."],
      } satisfies HermesProactiveProviderStatus;
    }

    const probe = yield* withClient(connection, async (client) => {
      const compatibility = await client.connect();
      const cronReadable = client.hasCapability("cron.read");
      const jobs = cronReadable ? (await client.listCronJobs()).jobs : [];
      return { compatibility, cronReadable, jobs };
    }).pipe(Effect.result);

    if (probe._tag === "Failure") {
      return {
        providerInstanceId: connection.providerInstanceId,
        displayName: connection.displayName,
        profileKey: connection.profileKey,
        enabled: true,
        source: null,
        enabledJobCount: 0,
        residentThreads: [],
        diagnostics: ["Could not reach the Hermes gateway to establish proactive residency."],
      } satisfies HermesProactiveProviderStatus;
    }

    // Recorded even when degraded: the stored capability state is how the app
    // explains that a gateway cannot back the durable half of proactive mode.
    const source = yield* proactiveRepository
      .registerSource({
        providerInstanceId: connection.providerInstanceId,
        profileKey: connection.profileKey,
        compatibility: probe.success.compatibility,
        now,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("hermes.proactive.source-registration-failed", {
            providerInstanceId: connection.providerInstanceId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
    if (source !== null && source.state === "degraded") {
      diagnostics.push(
        `This gateway cannot replay events it emitted while T3 was closed (${source.diagnosticCode}). Runs are delivered live only.`,
      );
    }
    if (!probe.success.cronReadable) {
      diagnostics.push("This gateway does not expose cron.read, so no scheduled jobs were found.");
    }

    const enabledJobs = probe.success.jobs.filter((job) => hermesCronJobIsEnabled(job));
    const jobSessionKeys = new Set(
      enabledJobs.flatMap((job) => {
        const key = hermesCronJobSessionKey(job);
        return key === null ? [] : [key];
      }),
    );
    if (enabledJobs.length === 0) {
      return {
        providerInstanceId: connection.providerInstanceId,
        displayName: connection.displayName,
        profileKey: connection.profileKey,
        enabled: true,
        source,
        enabledJobCount: 0,
        residentThreads: [],
        diagnostics,
      } satisfies HermesProactiveProviderStatus;
    }

    const profileBindings = yield* bindings
      .listProfileBindings({
        providerInstanceId: connection.providerInstanceId,
        profileKey: connection.profileKey,
        limit: MAX_RESIDENT_THREADS_PER_PROFILE,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("hermes.proactive.binding-lookup-failed", {
            providerInstanceId: connection.providerInstanceId,
            cause,
          }).pipe(Effect.as([])),
        ),
      );
    const targeted = profileBindings.filter((binding) =>
      jobSessionKeys.has(binding.storedSessionKey),
    );
    if (jobSessionKeys.size === 0) {
      diagnostics.push(
        "Scheduled jobs do not name their session, so the most recent Hermes threads are kept subscribed instead.",
      );
    }
    // Falling back to recency keeps the feature working on gateways whose cron
    // rows carry no session identity, which is the pinned-protocol default.
    const candidates = targeted.length > 0 ? targeted : profileBindings;
    const selectedBy = targeted.length > 0 ? ("job" as const) : ("recent" as const);

    const resident: Array<HermesProactiveResidentThread> = [];
    for (const binding of candidates) {
      const opened = yield* ensureResident({
        threadId: binding.threadId,
        providerInstanceId: connection.providerInstanceId,
      });
      if (!opened) continue;
      resident.push({
        providerInstanceId: connection.providerInstanceId,
        threadId: binding.threadId,
        storedSessionKey: binding.storedSessionKey,
        selectedBy,
      });
    }
    if (resident.length === 0 && candidates.length > 0) {
      diagnostics.push("No Hermes thread could be kept subscribed for this profile.");
    }

    return {
      providerInstanceId: connection.providerInstanceId,
      displayName: connection.displayName,
      profileKey: connection.profileKey,
      enabled: true,
      source,
      enabledJobCount: enabledJobs.length,
      residentThreads: resident,
      diagnostics,
    } satisfies HermesProactiveProviderStatus;
  });

  const sweep: HermesProactiveServiceShape["sweep"] = () =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(Effect.result);
      if (settings._tag === "Failure") {
        yield* Effect.logWarning("hermes.proactive.settings-unavailable", {
          cause: settings.failure,
        });
        return yield* Ref.get(lastReport);
      }
      const directory = resolveHermesProviderConnections(settings.success);
      const providers = yield* Effect.forEach(directory.ready, sweepProvider, {
        concurrency: 1,
      });
      const report: HermesProactiveStatusResult = {
        providers,
        sweptAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* Ref.set(lastReport, report);
      return report;
    });

  return HermesProactiveService.of({
    sweep,
    // A reader that arrives before the first sweep gets a real answer rather
    // than an empty one that reads as "no Hermes providers configured".
    report: () =>
      Effect.flatMap(Ref.get(lastReport), (report) =>
        report.sweptAt === null ? sweep() : Effect.succeed(report),
      ),
  });
});

/**
 * Provided for compositions that resolve the service from context. The RPC
 * layer builds it directly with {@link make} so it can own the sweep fiber's
 * lifetime alongside the other Hermes services.
 */
export const layer = Layer.effect(HermesProactiveService, make());
