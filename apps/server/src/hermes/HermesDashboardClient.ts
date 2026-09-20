import { HermesWorkError } from "@t3tools/contracts";
import { Context, Effect, Exit, Layer, Scope, Semaphore, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import {
  makeHermesServeRuntime,
  type HermesServeRuntimeShape,
  type HermesServeConnection,
} from "./HermesServeRuntime.ts";

import * as ServerSettings from "../serverSettings.ts";
import {
  resolveHermesProviderConnections,
  type HermesProviderConnection,
} from "./HermesProviderDirectory.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const isWorkError = Schema.is(HermesWorkError);

export interface HermesDashboardRequest {
  readonly providerInstanceId: string;
  readonly profile?: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly body?: unknown;
}

export interface HermesDashboardConnection {
  readonly providerInstanceId: string;
  readonly displayName: string;
  readonly configured: boolean;
}

export class HermesDashboardClient extends Context.Service<
  HermesDashboardClient,
  {
    readonly connection: (
      providerInstanceId: string,
    ) => Effect.Effect<HermesProviderConnection, HermesWorkError>;
    readonly request: (input: HermesDashboardRequest) => Effect.Effect<unknown, HermesWorkError>;
    readonly connections: () => Effect.Effect<
      { readonly connections: ReadonlyArray<HermesDashboardConnection> },
      HermesWorkError
    >;
  }
>()("t3/hermes/HermesDashboardClient") {}

export interface HermesDashboardClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly ensureReady?: (
    provider: HermesProviderConnection,
  ) => Effect.Effect<void | HermesServeConnection, HermesWorkError>;
}

export const makeHermesDashboardClient = (options: HermesDashboardClientOptions = {}) =>
  Effect.gen(function* () {
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const fetch = options.fetch ?? globalThis.fetch;
    const directory = settingsService.getSettings.pipe(
      Effect.map(resolveHermesProviderConnections),
      Effect.mapError(
        () =>
          new HermesWorkError({ code: "unavailable", message: "Could not read Hermes settings." }),
      ),
    );
    const connections = Effect.fn("HermesDashboardClient.connections")(function* () {
      const providers = yield* directory;
      return {
        connections: [
          ...providers.ready.map(({ providerInstanceId, displayName }) => ({
            providerInstanceId,
            displayName,
            configured: true,
          })),
          ...providers.unavailable.map(({ providerInstanceId, displayName }) => ({
            providerInstanceId,
            displayName,
            configured: false,
          })),
        ],
      };
    });
    const connection = Effect.fn("HermesDashboardClient.connection")(function* (
      providerInstanceId: string,
    ) {
      const providers = yield* directory;
      const provider = providers.ready.find(
        (entry) => entry.providerInstanceId === providerInstanceId,
      );
      if (!provider)
        return yield* new HermesWorkError({
          code: "not_configured",
          message: "Hermes is not connected. Check its environment settings.",
        });
      const ready = options.ensureReady ? yield* options.ensureReady(provider) : undefined;
      return ready ? { ...provider, endpoint: ready.endpoint, token: ready.authToken } : provider;
    });
    const request = Effect.fn("HermesDashboardClient.request")(function* (
      input: HermesDashboardRequest,
    ) {
      const provider = yield* connection(input.providerInstanceId);
      // Only server-owned API paths are accepted. Credentials never follow redirects.
      if (
        !input.path.startsWith("/api/") ||
        /[?#\\]/u.test(input.path) ||
        input.path.split("/").some((segment) => segment === "." || segment === "..")
      ) {
        return yield* new HermesWorkError({
          code: "invalid_input",
          message: "Invalid Hermes API path.",
        });
      }
      const url = new URL(provider.endpoint);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      url.pathname = input.path;
      url.search = "";
      url.hash = "";
      for (const [key, value] of Object.entries(input.query ?? {}))
        url.searchParams.set(key, String(value));
      if (input.profile !== undefined) url.searchParams.set("profile", input.profile);
      const mutation = input.method !== "GET";
      const uncertain = () =>
        new HermesWorkError({
          code: mutation ? "indeterminate" : "unavailable",
          message: mutation
            ? "Hermes did not confirm the operation. Refresh its state before trying again; it may have completed."
            : "Could not reach Hermes. Check that its background service is running.",
        });
      const response = yield* Effect.tryPromise({
        try: async (signal) => {
          const result = await fetch(url, {
            method: input.method,
            headers: {
              Authorization: `Bearer ${provider.token}`,
              Accept: "application/json",
              ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(input.body === undefined ? {} : { body: encodeJson(input.body) }),
            redirect: "error",
            signal,
          });
          if (result.status === 401 || result.status === 403)
            throw new HermesWorkError({
              code: "unauthorized",
              message: "Hermes rejected the connection credentials or permissions.",
            });
          if (result.status === 404)
            throw new HermesWorkError({
              code: "not_found",
              message: "The requested Hermes resource was not found.",
            });
          if (result.status === 405 || result.status === 501)
            throw new HermesWorkError({
              code: "unsupported",
              message: "This Hermes version does not support the requested operation.",
            });
          if (result.status === 400 || result.status === 422)
            throw new HermesWorkError({
              code: "invalid_input",
              message: "Hermes rejected the requested values. Review the task settings.",
            });
          if (result.status === 409)
            throw new HermesWorkError({
              code: "conflict",
              message: "Hermes state changed. Refresh before trying again.",
            });
          if (!result.ok)
            throw new HermesWorkError({
              code: mutation && result.status >= 500 ? "indeterminate" : "unavailable",
              message: `Hermes returned HTTP ${result.status}. Refresh its state before trying again.`,
            });
          if (result.status === 204) return null;
          try {
            return (await result.json()) as unknown;
          } catch {
            throw new HermesWorkError({
              code: mutation ? "indeterminate" : "invalid_response",
              message: mutation
                ? "Hermes returned an unreadable confirmation. Refresh its state before trying again."
                : "Hermes returned an unreadable response.",
            });
          }
        },
        catch: (cause) => (isWorkError(cause) ? cause : uncertain()),
      }).pipe(
        Effect.timeoutOrElse({
          duration: options.timeoutMs ?? 30_000,
          orElse: () => Effect.fail(uncertain()),
        }),
      );
      return response;
    });
    return HermesDashboardClient.of({ request, connections, connection });
  });

export const hermesDashboardClientLayer = Layer.effect(
  HermesDashboardClient,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const settings = yield* ServerSettings.ServerSettingsService;
    const mutex = yield* Semaphore.make(1);
    /**
     * One runtime per provider instance, not per credential.
     *
     * Keying by the credential instead would leave the superseded runtime — and
     * the `hermes serve` child it launched — holding the port after a token or
     * environment change, because its finalizer belongs to this layer's scope
     * and only runs at shutdown. The replacement would then probe that stale
     * listener with the new token, be rejected, find the port occupied, and
     * report `endpoint_in_use` for the rest of the process lifetime. Closing the
     * previous runtime's own scope first stops its child before the replacement
     * tries to claim the port.
     */
    const runtimes = new Map<
      string,
      {
        readonly key: string;
        readonly runtime: HermesServeRuntimeShape;
        readonly scope: Scope.Closeable;
      }
    >();
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...runtimes.values()],
        (entry) => Scope.close(entry.scope, Exit.void).pipe(Effect.ignore),
        { discard: true },
      ).pipe(Effect.tap(() => Effect.sync(() => runtimes.clear()))),
    );
    const ensureReady = Effect.fn("HermesDashboardClient.ensureReady")(function* (
      provider: HermesProviderConnection,
    ) {
      const config = yield* settings.getSettings.pipe(
        Effect.mapError(
          () =>
            new HermesWorkError({
              code: "unavailable",
              message: "Could not read Hermes settings.",
            }),
        ),
      );
      const instance = Object.entries(deriveProviderInstanceConfigMap(config)).find(
        ([id]) => id === provider.providerInstanceId,
      )?.[1];
      const key = encodeJson([
        provider.endpoint,
        provider.token,
        instance?.environment ?? [],
        provider.settings.managedServerEnabled,
      ]);
      const runtime = yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const existing = runtimes.get(provider.providerInstanceId);
          if (existing?.key === key) return existing.runtime;
          if (existing !== undefined) {
            // Stop the process the previous credential launched before the
            // replacement tries to claim the same port.
            runtimes.delete(provider.providerInstanceId);
            yield* Scope.close(existing.scope, Exit.void).pipe(Effect.ignore);
          }
          const runtimeScope = yield* Scope.make();
          const created = yield* makeHermesServeRuntime({
            endpoint: provider.endpoint,
            authToken: provider.token,
            managedServerEnabled: provider.settings.managedServerEnabled,
            processEnvironment: mergeProviderInstanceEnvironment(instance?.environment),
          }).pipe(
            Effect.provideService(Scope.Scope, runtimeScope),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          runtimes.set(provider.providerInstanceId, {
            key,
            runtime: created,
            scope: runtimeScope,
          });
          return created;
        }),
      );
      return yield* runtime.ensureReady.pipe(
        Effect.mapError(
          (error) => new HermesWorkError({ code: "unavailable", message: error.message }),
        ),
      );
    });
    return yield* makeHermesDashboardClient({ ensureReady });
  }),
);
