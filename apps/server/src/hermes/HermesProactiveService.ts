import {
  HermesProactiveEventKinds,
  ProviderInstanceId,
  ThreadId,
  type HermesGatewayCompatibility,
  type HermesGatewayCronJob,
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
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ServerSettings from "../serverSettings.ts";
import { projectHermesCronJob } from "./HermesCron.ts";
import { HermesGatewayClient } from "./HermesGatewayClient.ts";
import {
  HermesProactiveEventRepository,
  type HermesCronRunWatermark,
} from "./HermesProactiveEventRepository.ts";
import {
  describeScheduledRun,
  describeScheduledRunBody,
  HermesProactiveInbox,
  type HermesProactiveInboxShape,
} from "./HermesProactiveInbox.ts";
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
  /**
   * Forks the recurring sweep into the caller's scope. Called once, by server
   * startup, so the schedule keeps being watched with no client connected.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
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
  readonly inbox?: HermesProactiveInboxShape;
  /**
   * Overrides the process-wide first-sweep memory. Tests use it to stand up two
   * services that behave like two separate runs of the server.
   */
  readonly sweptSources?: Set<string>;
}

/**
 * Bindings read per sweep. Residency only subscribes the newest few, but the
 * rest are needed to name the thread a missed run belongs to.
 */
const PROFILE_BINDING_LOOKUP_LIMIT = 200;

/**
 * Shared by every service instance in the process, because "T3 was closed" is a
 * fact about the process and not about one websocket session. A service is
 * built per connection, so keeping this per-instance would let a second client
 * connecting mid-run report a live run as a missed one.
 */
const processSweptSources = new Set<string>();

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
  const inbox = options.inbox ?? (yield* HermesProactiveInbox);
  const orchestrator = yield* Effect.serviceOption(OrchestratorV2);
  // Sources already swept. Only the first pass can attribute a moved watermark
  // to T3 having been closed.
  const sweptSources = options.sweptSources ?? processSweptSources;
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

  /**
   * Turns a cron job whose last run moved into an inbox entry.
   *
   * Every moved run is reported, not only the ones that happened while T3 was
   * closed. A Hermes cron job does not run inside the gateway session T3
   * subscribes to — it spawns its own, finishes, and ends it — so there is no
   * live stream to double up with, and treating these as the exceptional case
   * is what let a schedule fail for days without saying so. The one live path
   * that does exist is a run on a session T3 has resident, which the adapter
   * announces itself; that stays suppressed here.
   *
   * A run is new when its reported time moved, or when the same time now
   * carries a different outcome — a gateway that retries in place would
   * otherwise never get to say that the retry failed too.
   */
  const reconcileCronRuns = Effect.fn("HermesProactiveService.reconcileCronRuns")(
    function* (input: {
      readonly connection: HermesProviderConnection;
      readonly jobs: ReadonlyArray<HermesGatewayCronJob>;
      readonly threadBySessionKey: ReadonlyMap<string, string>;
      readonly residentSessionKeys: ReadonlySet<string>;
      readonly now: string;
    }) {
      const { connection } = input;
      const sourceKey = `${connection.providerInstanceId}\u0000${connection.profileKey}`;
      const firstSweep = !sweptSources.has(sourceKey);
      sweptSources.add(sourceKey);

      const known = yield* proactiveRepository
        .listCronWatermarks({
          providerInstanceId: connection.providerInstanceId,
          profileKey: connection.profileKey,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("hermes.proactive.watermark-read-failed", {
              providerInstanceId: connection.providerInstanceId,
              cause,
            }).pipe(Effect.as([])),
          ),
        );
      const previous = new Map(known.map((entry) => [entry.jobIdentity, entry] as const));

      let reported = 0;
      let failures = 0;
      const watermarks: Array<HermesCronRunWatermark> = [];
      for (const [ordinal, gatewayJob] of input.jobs.entries()) {
        const job = projectHermesCronJob(
          connection.providerInstanceId,
          connection.profileKey,
          gatewayJob,
          ordinal,
        );
        const sessionKey = hermesCronJobSessionKey(gatewayJob);
        const threadId =
          sessionKey === null ? null : (input.threadBySessionKey.get(sessionKey) ?? null);
        const lastRunAt = job.lastRunAt === null ? null : String(job.lastRunAt);
        watermarks.push({
          providerInstanceId: connection.providerInstanceId,
          profileKey: connection.profileKey,
          jobIdentity: job.identity,
          jobName: job.name,
          lastRunAt,
          lastStatus: job.lastStatus,
          threadId,
        });

        const seen = previous.get(job.identity);
        // A job discovered for the first time reports nothing: its last run
        // predates T3 knowing the job exists, and announcing it would be noise on
        // every fresh install.
        if (lastRunAt === null || seen === undefined) continue;
        if (seen.lastRunAt === lastRunAt && seen.lastStatus === job.lastStatus) continue;
        const witnessedLive = sessionKey !== null && input.residentSessionKeys.has(sessionKey);
        if (!firstSweep && witnessedLive) continue;

        const runFailed = job.lastOutcome === "failed";
        yield* inbox.witness({
          providerInstanceId: connection.providerInstanceId,
          profileKey: connection.profileKey,
          // The status is part of the identity so the same run time reported
          // with a new outcome is a distinct entry rather than a silent
          // duplicate of the one already delivered.
          runIdentity: `${job.identity}:${lastRunAt}:${job.lastStatus ?? "unknown"}`,
          eventKind: runFailed
            ? HermesProactiveEventKinds.cronRunFailed
            : HermesProactiveEventKinds.cronRunMissed,
          title: describeScheduledRun({ jobName: job.name, outcome: job.lastOutcome }),
          body: describeScheduledRunBody({
            outcome: job.lastOutcome,
            error: job.lastError,
            hasThread: threadId !== null,
          }),
          threadId,
          projectId: null,
          occurredAt: input.now,
        });
        reported += 1;
        if (runFailed) failures += 1;
      }

      yield* proactiveRepository.upsertCronWatermarks({ watermarks, now: input.now }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("hermes.proactive.watermark-write-failed", {
            providerInstanceId: connection.providerInstanceId,
            cause,
          }),
        ),
      );
      return { reported, failures };
    },
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
        `This gateway cannot stream back events it emitted while T3 was closed (${source.diagnosticCode}). Scheduled runs are still reported from the schedule, and their transcripts can be imported.`,
      );
    }
    if (!probe.success.cronReadable) {
      diagnostics.push("This gateway does not implement cron, so no scheduled jobs were found.");
    }

    const enabledJobs = probe.success.jobs.filter((job) => hermesCronJobIsEnabled(job));
    const jobSessionKeys = new Set(
      enabledJobs.flatMap((job) => {
        const key = hermesCronJobSessionKey(job);
        return key === null ? [] : [key];
      }),
    );

    // Residency is not conditional on there being cron jobs. It is also what
    // carries a prompt sent to the same session by another Hermes client, and
    // a profile with no schedule at all still has those.
    //
    // Read wider than residency needs: the extra rows are what turn a job's
    // session key into the thread a run notification should open, and
    // residency still only keeps the newest few subscribed.
    const profileBindings = yield* bindings
      .listProfileBindings({
        providerInstanceId: connection.providerInstanceId,
        profileKey: connection.profileKey,
        limit: PROFILE_BINDING_LOOKUP_LIMIT,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("hermes.proactive.binding-lookup-failed", {
            providerInstanceId: connection.providerInstanceId,
            cause,
          }).pipe(Effect.as([])),
        ),
      );
    const threadBySessionKey = new Map(
      profileBindings.map((binding) => [binding.storedSessionKey, binding.threadId] as const),
    );
    const residencyCandidates = profileBindings.slice(0, MAX_RESIDENT_THREADS_PER_PROFILE);
    const targeted = residencyCandidates.filter((binding) =>
      jobSessionKeys.has(binding.storedSessionKey),
    );
    if (enabledJobs.length > 0 && jobSessionKeys.size === 0) {
      diagnostics.push(
        "Scheduled runs happen on their own Hermes session, so they are reported from the schedule rather than streamed. The most recent threads stay subscribed for everything else.",
      );
    }
    // Falling back to recency keeps the feature working on gateways whose cron
    // rows carry no session identity, which is the pinned-protocol default.
    const candidates = targeted.length > 0 ? targeted : residencyCandidates;
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

    const runs =
      enabledJobs.length === 0
        ? { reported: 0, failures: 0 }
        : yield* reconcileCronRuns({
            connection,
            jobs: enabledJobs,
            threadBySessionKey,
            residentSessionKeys: new Set(resident.map((thread) => thread.storedSessionKey)),
            now,
          });
    if (runs.reported > 0) {
      diagnostics.push(
        runs.failures > 0
          ? `${runs.reported} scheduled run(s) were added to the inbox, ${runs.failures} of them failed.`
          : `${runs.reported} scheduled run(s) were added to the inbox.`,
      );
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
    start: () =>
      sweep().pipe(
        Effect.catchCause((cause) => Effect.logWarning("hermes.proactive.sweep-failed", { cause })),
        Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
        Effect.forkScoped,
        Effect.asVoid,
      ),
  });
});

/**
 * Server-lifetime. A scheduled run reaches T3 only if something was watching
 * when it fired, so this cannot be scoped to a client connection: the sweep has
 * to keep running with every tab closed, and running one copy of it rather than
 * one per client is what keeps a multi-device setup from re-probing the gateway
 * N times an interval.
 */
export const layer = Layer.effect(HermesProactiveService, make());
