import {
  HermesCronError,
  type HermesCronCapabilities,
  type HermesCronExecution,
  type HermesCronJob,
  type HermesCronListResult,
  type HermesCronMutationInput,
  type HermesCronMutationResponse,
  type HermesCronProviderProjection,
  type HermesCronRunOutcome,
  type HermesGatewayCompatibility,
  type HermesGatewayCronJob,
  type HermesGatewayCronListResult,
  type HermesGatewayCronMutationResult,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import {
  HermesGatewayClient,
  HermesGatewayConfigurationError,
  HermesGatewayDuplicateOperationIdError,
  HermesGatewayMutationIndeterminateError,
  HermesGatewayMutationsBlockedError,
  type HermesGatewayMutationOptions,
  type HermesGatewayReadOptions,
} from "./HermesGatewayClient.ts";
import {
  hermesManageActionInventory,
  resolveHermesProviderConnections,
  type HermesProviderConnection,
} from "./HermesProviderDirectory.ts";

interface HermesCronGatewayClient {
  readonly compatibility: HermesGatewayCompatibility | undefined;
  connect(): Promise<HermesGatewayCompatibility>;
  hasCapability(capability: string): boolean;
  listCronJobs(
    options?: Omit<HermesGatewayReadOptions, "requiredCapability">,
  ): Promise<HermesGatewayCronListResult>;
  cronActionInventory(): Promise<ReadonlySet<string>>;
  manageCron(
    params: Record<string, unknown>,
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewayCronMutationResult>;
  close(): void;
}

type HermesCronProviderConfig = HermesProviderConnection;

export interface HermesCronOptions {
  readonly clientFactory?: (input: {
    readonly endpoint: string;
    readonly authToken: string;
  }) => HermesCronGatewayClient;
}

export interface HermesCronShape {
  readonly list: () => Effect.Effect<HermesCronListResult, HermesCronError>;
  readonly mutate: (
    input: HermesCronMutationInput,
  ) => Effect.Effect<HermesCronMutationResponse, HermesCronError>;
}

export class HermesCron extends Context.Service<HermesCron, HermesCronShape>()(
  "t3/hermes/HermesCron",
) {}

const isHermesCronError = Schema.is(HermesCronError);
const digest = (value: unknown): string =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const stringOrNumber = (value: unknown): string | number | undefined =>
  typeof value === "string" || typeof value === "number" ? value : undefined;

const NO_CRON_CAPABILITIES: HermesCronCapabilities = {
  inventory: false,
  create: false,
  edit: false,
  pause: false,
  resume: false,
  delete: false,
  runNow: false,
};

/**
 * What the connected gateway lets T3 do with cron.
 *
 * `probedActions` is the authoritative answer when it is present: it comes from
 * asking the gateway which actions its `cron.manage` dispatcher accepts, which
 * is the only way to know on a build that advertises nothing. Guessing was the
 * old behavior and it was wrong in both directions — it offered Edit and Run
 * now, which the shipped gateway rejects, and hid Pause and Resume, which it
 * supports.
 */
export function projectHermesCronCapabilities(
  compatibility: HermesGatewayCompatibility,
  probedActions?: ReadonlySet<string>,
): HermesCronCapabilities {
  if (compatibility.status === "unsupported") return NO_CRON_CAPABILITIES;
  const capabilities = new Set(compatibility.capabilities);
  // The gateway client only accepts cron.read for list and cron.manage for
  // mutations, so the projection must not enable operations from granular
  // aliases that the client would reject.
  const manage = capabilities.has("cron.manage");
  const advertised = hermesManageActionInventory(compatibility, "cron.manage");
  const actions = probedActions ?? advertised;
  const allows = (...names: ReadonlyArray<string>) =>
    manage && (actions.size === 0 || names.some((name) => actions.has(name)));
  return {
    inventory: capabilities.has("cron.read"),
    create: allows("add", "create"),
    edit: allows("update", "edit"),
    pause: allows("pause"),
    resume: allows("resume"),
    delete: allows("remove", "delete"),
    runNow: allows("run", "run_now", "run-now"),
  };
}

function projectExecution(
  input: {
    readonly providerInstanceId: string;
    readonly profileKey: string;
    readonly jobIdentity: string;
  },
  value: unknown,
): HermesCronExecution | null {
  const row = record(value);
  if (!row) return null;
  const upstreamRunId = string(row.run_id) ?? string(row.id) ?? null;
  const upstreamCursor = stringOrNumber(row.cursor) ?? stringOrNumber(row.sequence) ?? null;
  const startedAt =
    stringOrNumber(row.started_at) ??
    stringOrNumber(row.startedAt) ??
    stringOrNumber(row.created_at) ??
    null;
  const completedAt =
    stringOrNumber(row.completed_at) ??
    stringOrNumber(row.completedAt) ??
    stringOrNumber(row.finished_at) ??
    null;
  const status = string(row.status) ?? null;
  const stableFields = {
    jobIdentity: input.jobIdentity,
    upstreamRunId,
    upstreamCursor,
    startedAt,
    completedAt,
    status,
  };
  return {
    dedupeKey: upstreamRunId
      ? `hermes-run:${upstreamRunId}`
      : `hermes-derived:${digest(stableFields)}`,
    status,
    startedAt,
    completedAt,
    provenance: {
      scheduler: "hermes",
      providerInstanceId: input.providerInstanceId,
      profileKey: input.profileKey,
      jobIdentity: input.jobIdentity,
      upstreamRunId,
      upstreamCursor,
      identityStrength: upstreamRunId || upstreamCursor !== null ? "upstream" : "derived",
    },
  };
}

/**
 * Normalizes the many spellings a gateway may use for "how did the last run
 * end". Hermes reports `error` for a failed run and `success` for a good one,
 * but nothing in the pinned protocol fixes that vocabulary.
 */
export function projectHermesCronRunOutcome(status: string | null): HermesCronRunOutcome {
  if (status === null) return "unknown";
  const normalized = status.trim().toLowerCase();
  if (normalized.length === 0) return "unknown";
  if (/(^|_)(error|fail|failed|failure|timeout|cancelled|canceled)($|_)/.test(normalized)) {
    return "failed";
  }
  if (/(^|_)(running|started|in_progress|claimed|pending)($|_)/.test(normalized)) return "running";
  if (/(^|_)(success|succeeded|ok|complete|completed|done)($|_)/.test(normalized)) {
    return "succeeded";
  }
  return "unknown";
}

export function projectHermesCronJob(
  providerInstanceId: string,
  profileKey: string,
  job: HermesGatewayCronJob,
  ordinal: number,
): HermesCronJob {
  // The shipped gateway names these `job_id` and `prompt_preview`; the pinned
  // protocol requires neither spelling, so both are read.
  const id = (job.id ?? job.job_id)?.trim() || null;
  const name = job.name?.trim() || null;
  const prompt = (job.prompt ?? job.prompt_preview)?.trim() || null;
  const identity = id ?? name ?? `unaddressable:${digest([job.schedule, prompt, ordinal])}`;
  const lastStatus = job.last_status?.trim() || null;
  const executionRows = job.executions ?? job.runs ?? job.history ?? [];
  const deduped = new Map<string, HermesCronExecution>();
  for (const value of executionRows) {
    const projected = projectExecution(
      { providerInstanceId, profileKey, jobIdentity: identity },
      value,
    );
    if (projected) deduped.set(projected.dedupeKey, projected);
  }
  return {
    identity,
    identityStrength: id ? "id" : name ? "name" : "missing",
    id,
    name,
    schedule: job.schedule ?? null,
    prompt,
    enabled: job.enabled ?? (job.paused === undefined ? null : !job.paused),
    nextRunAt: job.next_run_at ?? null,
    lastRunAt: job.last_run_at ?? null,
    lastOutcome: projectHermesCronRunOutcome(lastStatus),
    lastStatus,
    // The shipped gateway keeps the run's own error out of the inventory and
    // reports only a delivery failure, so either is taken as "what went wrong
    // last". `lastOutcome` still comes from the run status alone.
    lastError: job.last_error?.trim() || job.last_delivery_error?.trim() || null,
    state: job.state?.trim() || job.paused_reason?.trim() || null,
    workdir: job.workdir?.trim() || null,
    executions: [...deduped.values()],
  };
}

function projectProvider(input: {
  readonly config: HermesCronProviderConfig;
  readonly compatibility: HermesGatewayCompatibility;
  readonly result: HermesGatewayCronListResult;
  readonly actions: ReadonlySet<string>;
}): HermesCronProviderProjection {
  const capabilities = projectHermesCronCapabilities(input.compatibility, input.actions);
  if (!input.result.success) {
    return {
      providerInstanceId: input.config.providerInstanceId,
      displayName: input.config.displayName,
      profileKey: input.config.profileKey,
      status: "error",
      protocolClassification: input.compatibility.status,
      capabilities,
      jobs: [],
      diagnostics: ["Hermes gateway reported an unsuccessful cron inventory response."],
    };
  }
  const diagnostics: string[] = [];
  const jobs = input.result.jobs.map((job, index) =>
    projectHermesCronJob(input.config.providerInstanceId, input.config.profileKey, job, index),
  );
  const missingIdentity = jobs.filter((job) => job.identityStrength === "missing").length;
  if (missingIdentity > 0) {
    diagnostics.push(
      `${missingIdentity} cron job(s) have no upstream id or name and cannot be safely mutated.`,
    );
  }
  const observedExecutions = jobs.some((job) => job.executions.length > 0);
  if (
    observedExecutions &&
    !jobs.some((job) => job.executions.some((run) => run.provenance.upstreamCursor !== null))
  ) {
    diagnostics.push("Hermes does not expose a durable global cron execution cursor.");
  }
  const unsupported = (
    [
      ["edit", capabilities.edit],
      ["run now", capabilities.runNow],
      ["pause", capabilities.pause],
      ["resume", capabilities.resume],
      ["delete", capabilities.delete],
    ] as const
  ).flatMap(([label, allowed]) => (allowed ? [] : [label]));
  if (unsupported.length > 0) {
    diagnostics.push(`This gateway does not implement cron ${unsupported.join(", ")}.`);
  }
  return {
    providerInstanceId: input.config.providerInstanceId,
    displayName: input.config.displayName,
    profileKey: input.config.profileKey,
    status: "ready",
    protocolClassification: input.compatibility.status,
    capabilities,
    jobs,
    diagnostics,
  };
}

const unavailableProjection = (
  providerInstanceId: string,
  displayName: string,
  profileKey: string,
  diagnostic: string,
  status: "unavailable" | "error" = "unavailable",
): HermesCronProviderProjection => ({
  providerInstanceId,
  displayName,
  profileKey,
  status,
  protocolClassification: null,
  capabilities: {
    inventory: false,
    create: false,
    edit: false,
    pause: false,
    resume: false,
    delete: false,
    runNow: false,
  },
  jobs: [],
  diagnostics: [diagnostic],
});

function mutationCapability(
  capabilities: HermesCronCapabilities,
  operation: HermesCronMutationInput["operation"],
): boolean {
  switch (operation) {
    case "create":
      return capabilities.create;
    case "edit":
      return capabilities.edit;
    case "pause":
      return capabilities.pause;
    case "resume":
      return capabilities.resume;
    case "delete":
      return capabilities.delete;
    case "run_now":
      return capabilities.runNow;
  }
}

function mutationParams(input: HermesCronMutationInput): Record<string, unknown> {
  switch (input.operation) {
    case "create":
      return { action: "add", name: input.name, schedule: input.schedule, prompt: input.prompt };
    case "edit":
      return {
        action: "update",
        name: input.jobIdentity,
        ...(input.name === undefined ? {} : { new_name: input.name }),
        ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      };
    case "pause":
      return { action: "pause", name: input.jobIdentity };
    case "resume":
      return { action: "resume", name: input.jobIdentity };
    case "delete":
      return { action: "remove", name: input.jobIdentity };
    case "run_now":
      return { action: "run", name: input.jobIdentity };
  }
}

export const makeHermesCron = Effect.fn("HermesCron.make")(function* (
  options: HermesCronOptions = {},
) {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const clientFactory =
    options.clientFactory ??
    ((input: { readonly endpoint: string; readonly authToken: string }) =>
      new HermesGatewayClient(input));
  // Clients are shared per connection so mutation operationId fences survive
  // across cron calls instead of dying with a per-call client. The fence only
  // has to survive for the same connection identity: when an instance's
  // endpoint or token changes, the superseded client is closed and evicted so
  // stale connections do not accumulate.
  const clients = new Map<
    string,
    { readonly connectionKey: string; readonly client: HermesCronGatewayClient }
  >();
  const sharedClient = (config: HermesCronProviderConfig): HermesCronGatewayClient => {
    const connectionKey = `${config.endpoint}\u0000${config.token}`;
    const existing = clients.get(config.providerInstanceId);
    if (existing !== undefined && existing.connectionKey === connectionKey) {
      return existing.client;
    }
    existing?.client.close();
    const client = clientFactory({ endpoint: config.endpoint, authToken: config.token });
    clients.set(config.providerInstanceId, { connectionKey, client });
    return client;
  };
  // Providers that leave the ready directory (disabled, unconfigured, or
  // removed) must not keep a live gateway connection around.
  const pruneClients = (readyIds: ReadonlySet<string>): void => {
    for (const [providerInstanceId, entry] of clients) {
      if (readyIds.has(providerInstanceId)) continue;
      entry.client.close();
      clients.delete(providerInstanceId);
    }
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const entry of clients.values()) entry.client.close();
      clients.clear();
    }),
  );

  const configuredProviders = Effect.fn("HermesCron.configuredProviders")(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        () =>
          new HermesCronError({
            code: "gateway_error",
            message: "Could not read Hermes provider settings.",
          }),
      ),
    );
    const directory = resolveHermesProviderConnections(settings);
    pruneClients(new Set(directory.ready.map((provider) => provider.providerInstanceId)));
    return {
      ready: directory.ready,
      unavailable: directory.unavailable.map((provider) =>
        unavailableProjection(
          provider.providerInstanceId,
          provider.displayName,
          provider.profileKey,
          provider.diagnostic,
        ),
      ),
    };
  });

  const loadProvider = Effect.fn("HermesCron.loadProvider")(function* (
    config: HermesCronProviderConfig,
  ) {
    return yield* Effect.tryPromise({
      try: async () => {
        const client = sharedClient(config);
        const compatibility = await client.connect();
        if (!projectHermesCronCapabilities(compatibility).inventory) {
          return unavailableProjection(
            config.providerInstanceId,
            config.displayName,
            config.profileKey,
            "This gateway does not implement cron.",
          );
        }
        const [result, actions] = await Promise.all([
          client.listCronJobs(),
          client.cronActionInventory(),
        ]);
        return projectProvider({ config, compatibility, result, actions });
      },
      catch: () =>
        new HermesCronError({
          code: "gateway_error",
          providerInstanceId: config.providerInstanceId,
          message: "Could not read native Hermes cron inventory.",
        }),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          unavailableProjection(
            config.providerInstanceId,
            config.displayName,
            config.profileKey,
            error.message,
            "error",
          ),
        ),
      ),
    );
  });

  const list: HermesCronShape["list"] = Effect.fn("HermesCron.list")(function* () {
    const configured = yield* configuredProviders();
    const available = yield* Effect.forEach(configured.ready, loadProvider, { concurrency: 4 });
    return { providers: [...available, ...configured.unavailable] };
  });

  const mutate: HermesCronShape["mutate"] = Effect.fn("HermesCron.mutate")(function* (input) {
    if (
      !input.operationId.trim() ||
      (input.operation === "create" &&
        (!input.name?.trim() || !input.schedule?.trim() || !input.prompt?.trim())) ||
      (input.operation !== "create" && !input.jobIdentity?.trim())
    ) {
      return yield* new HermesCronError({
        code: "invalid_input",
        providerInstanceId: input.providerInstanceId,
        operation: input.operation,
        message: "Cron mutation is missing required identity or job fields.",
      });
    }
    const configured = yield* configuredProviders();
    const config = configured.ready.find(
      (candidate) => candidate.providerInstanceId === input.providerInstanceId,
    );
    if (!config) {
      const known = configured.unavailable.some(
        (candidate) => candidate.providerInstanceId === input.providerInstanceId,
      );
      return yield* new HermesCronError({
        code: known ? "provider_unavailable" : "provider_not_found",
        providerInstanceId: input.providerInstanceId,
        operation: input.operation,
        message: known ? "Hermes provider is unavailable." : "Hermes provider was not found.",
      });
    }

    return yield* Effect.tryPromise({
      try: async () => {
        const client = sharedClient(config);
        const compatibility = await client.connect();
        const actions = await client.cronActionInventory();
        const capabilities = projectHermesCronCapabilities(compatibility, actions);
        if (!mutationCapability(capabilities, input.operation)) {
          throw new HermesCronError({
            code: "unsupported_operation",
            providerInstanceId: input.providerInstanceId,
            operation: input.operation,
            message: `Hermes gateway does not support cron ${input.operation}.`,
          });
        }
        const result = await client.manageCron(mutationParams(input), {
          operationId: input.operationId,
        });
        if (!result.success) {
          throw new HermesCronError({
            code: "gateway_error",
            providerInstanceId: input.providerInstanceId,
            operation: input.operation,
            message: `Hermes gateway rejected cron ${input.operation}.`,
          });
        }
        const inventory = await client.listCronJobs().catch(() => null);
        return {
          provider: inventory
            ? projectProvider({ config, compatibility, result: inventory, actions })
            : unavailableProjection(
                config.providerInstanceId,
                config.displayName,
                config.profileKey,
                "Cron mutation succeeded, but the follow-up cron inventory refresh failed.",
                "error",
              ),
          upstreamJobId: result.job_id ?? result.job?.id ?? null,
          upstreamRunId: result.run_id ?? null,
        };
      },
      catch: (cause) => {
        if (isHermesCronError(cause)) return cause;
        if (cause instanceof HermesGatewayMutationIndeterminateError) {
          return new HermesCronError({
            code: "indeterminate",
            providerInstanceId: input.providerInstanceId,
            operation: input.operation,
            message: "Hermes cron mutation outcome is indeterminate; automatic replay is disabled.",
          });
        }
        if (cause instanceof HermesGatewayMutationsBlockedError) {
          return new HermesCronError({
            code: "indeterminate",
            providerInstanceId: input.providerInstanceId,
            operation: input.operation,
            message:
              "Hermes cron mutations are blocked until indeterminate operations are reconciled.",
          });
        }
        if (cause instanceof HermesGatewayDuplicateOperationIdError) {
          return new HermesCronError({
            code: "invalid_input",
            providerInstanceId: input.providerInstanceId,
            operation: input.operation,
            message:
              "Hermes cron mutation operation id was already used; duplicate submissions are not replayed.",
          });
        }
        if (cause instanceof HermesGatewayConfigurationError) {
          return new HermesCronError({
            code: "gateway_error",
            providerInstanceId: input.providerInstanceId,
            operation: input.operation,
            message: `Hermes cron gateway is not configured correctly: ${cause.message}`,
          });
        }
        return new HermesCronError({
          code: "gateway_error",
          providerInstanceId: input.providerInstanceId,
          operation: input.operation,
          message: "Hermes cron gateway operation failed.",
        });
      },
    });
  });

  return HermesCron.of({ list, mutate });
});

export const layer = Layer.effect(HermesCron, makeHermesCron());
