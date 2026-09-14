import { startHermesWorkGateway } from "./HermesWorkGateway.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import {
  HermesSettings,
  HermesWorkError,
  ProviderInstanceId,
  type HermesWorkSetupInput,
  type HermesWorkSetupState,
} from "@t3tools/contracts";
import {
  Cause,
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  Path,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import { ServerSettingsService } from "../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { HermesDashboardClient } from "./HermesDashboardClient.ts";
import { HermesWorkModelAuth } from "./HermesWorkModelAuth.ts";
import { HermesWorkInstaller } from "./HermesWorkInstaller.ts";
import { DEFAULT_HERMES_SERVE_ENDPOINT, resolveHermesServeEndpoint } from "./HermesServeRuntime.ts";

const decodeSettings = Schema.decodeUnknownEffect(HermesSettings);
const isWorkError = Schema.is(HermesWorkError);
const idle = (providerInstanceId: string): HermesWorkSetupState => ({
  providerInstanceId,
  phase: "idle",
  message: "Set up Hermes on this environment.",
  model: null,
});
const active = (state: HermesWorkSetupState) =>
  state.phase === "installing" || state.phase === "configuring" || state.phase === "connecting";

export class HermesWorkSetupService extends Context.Service<
  HermesWorkSetupService,
  {
    readonly start: (input: HermesWorkSetupInput) => Effect.Effect<HermesWorkSetupState>;
    readonly status: (input: HermesWorkSetupInput) => Effect.Effect<HermesWorkSetupState>;
    readonly wait: (input: HermesWorkSetupInput) => Effect.Effect<HermesWorkSetupState>;
  }
>()("t3/hermes/HermesWorkSetupService") {}

/** Installation runs only after an explicit setup request, in the server lifetime scope. */
export interface HermesWorkSetupOptions {
  readonly localEndpoint?: () => Promise<string>;
}
const allocateEndpoint = () =>
  new Promise<string>((resolve, reject) => {
    const listener = NodeNet.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("Could not allocate a Hermes port."));
        return;
      }
      const endpoint = `ws://127.0.0.1:${address.port}/api/ws`;
      listener.close((error) => (error ? reject(error) : resolve(endpoint)));
    });
  });
export const makeHermesWorkSetupService = (options: HermesWorkSetupOptions = {}) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const platformPath = yield* Path.Path;
    const delimiter = platformPath.sep === "\\" ? ";" : ":";
    const installer = yield* HermesWorkInstaller;
    const dashboard = yield* HermesDashboardClient;
    const modelAuth = yield* HermesWorkModelAuth;
    const scope = yield* Scope.Scope;
    const gate = yield* Semaphore.make(1);
    const states = new Map<string, HermesWorkSetupState>();
    const operations = new Map<string, Fiber.Fiber<void, never>>();
    const report = (
      providerInstanceId: string,
      phase: HermesWorkSetupState["phase"],
      message: string,
      model: string | null = null,
    ) => {
      const value = { providerInstanceId, phase, message, model };
      states.set(providerInstanceId, value);
      return value;
    };
    const run = Effect.fn("HermesWorkSetupService.run")(function* (providerInstanceId: string) {
      const before = yield* settings.getSettings;
      const id = ProviderInstanceId.make(providerInstanceId);
      const selected = deriveProviderInstanceConfigMap(before)[id];
      if (!selected || selected.driver !== "hermes")
        return yield* new HermesWorkError({
          code: "invalid_input",
          message: "Choose a Hermes provider to set up.",
        });
      const config = yield* decodeSettings(selected.config ?? {});
      const endpoint = resolveHermesServeEndpoint(config.endpoint);
      const parsed = new URL(endpoint);
      const remote = !["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
      const installation = remote ? null : yield* installer.ensureInstalled();
      report(
        providerInstanceId,
        "configuring",
        remote
          ? "Connecting your existing Hermes environment."
          : "Configuring the local Hermes connection.",
      );
      // Re-read after installation so unrelated settings edits made during it are preserved.
      const current = yield* settings.getSettings;
      const entry = deriveProviderInstanceConfigMap(current)[id];
      if (!entry || entry.driver !== "hermes")
        return yield* new HermesWorkError({
          code: "conflict",
          message: "The Hermes provider changed during setup. Start setup again.",
        });
      const latestConfig = yield* decodeSettings(entry.config ?? {});
      if (resolveHermesServeEndpoint(latestConfig.endpoint) !== endpoint)
        return yield* new HermesWorkError({
          code: "conflict",
          message: "The Hermes connection changed during setup. Start setup again.",
        });
      const environment = [...(entry.environment ?? [])];
      const tokenIndex = environment.findIndex(
        (variable) => variable.name === "HERMES_GATEWAY_TOKEN",
      );
      const existingToken = tokenIndex < 0 ? "" : (environment[tokenIndex]?.value.trim() ?? "");
      if (remote && !existingToken)
        return yield* new HermesWorkError({
          code: "not_configured",
          message:
            "Add the gateway token for your existing remote Hermes connection, then retry setup.",
        });
      const ownedEndpoint =
        !remote && !existingToken && !latestConfig.endpoint.trim()
          ? yield* Effect.tryPromise({
              try: options.localEndpoint ?? allocateEndpoint,
              catch: () =>
                new HermesWorkError({
                  code: "unavailable",
                  message: "Could not allocate a local Hermes connection.",
                }),
            })
          : latestConfig.endpoint || DEFAULT_HERMES_SERVE_ENDPOINT;
      const token = {
        name: "HERMES_GATEWAY_TOKEN",
        value: existingToken || NodeCrypto.randomBytes(32).toString("hex"),
        sensitive: true,
      };
      if (tokenIndex < 0) environment.push(token);
      else environment[tokenIndex] = token;
      if (installation) {
        const pathIndex = environment.findIndex((variable) => variable.name === "PATH");
        const existingPath =
          pathIndex < 0 ? (process.env.PATH ?? "") : (environment[pathIndex]?.value ?? "");
        const binDirectory = platformPath.dirname(installation.binaryPath);
        const path = {
          name: "PATH",
          value: [
            binDirectory,
            ...existingPath.split(delimiter).filter((part) => part && part !== binDirectory),
          ].join(delimiter),
          sensitive: false,
        };
        if (pathIndex < 0) environment.push(path);
        else environment[pathIndex] = path;
      }
      yield* settings.updateSettings({
        enableHermes: true,
        ...(remote ? { enableRemoteHermes: true } : {}),
        providers: { hermes: { enabled: true } },
        providerInstances: {
          ...current.providerInstances,
          [id]: {
            ...entry,
            enabled: true,
            environment,
            config: {
              ...latestConfig,
              enabled: true,
              endpoint: ownedEndpoint,
              ...(remote ? { remoteAccessEnabled: true } : { managedServerEnabled: true }),
            },
          },
        },
      });
      report(providerInstanceId, "connecting", "Starting and checking the Hermes connection.");
      yield* dashboard.connection(providerInstanceId);
      const models = yield* modelAuth.modelStatus({
        providerInstanceId,
        profile: latestConfig.profileKey,
      });
      const configured = models.ready;
      if (configured) {
        report(
          providerInstanceId,
          "connecting",
          "Hermes chat is connected. Starting background scheduling.",
          models.model,
        );
        yield* startHermesWorkGateway(dashboard, {
          providerInstanceId,
          profile: latestConfig.profileKey,
        }).pipe(
          Effect.mapError(
            (error) =>
              new HermesWorkError({
                code: error.code,
                message: `Hermes chat is connected, but scheduled tasks are unavailable. ${error.message}`,
              }),
          ),
        );
      }
      report(
        providerInstanceId,
        configured ? "connected" : "needs_model",
        configured
          ? `Hermes is connected with ${models.model}. Background scheduling is running.`
          : "Hermes is installed and connected. Sign in to a model provider and choose a model to start chatting.",
        models.model || null,
      );
    });
    const start = Effect.fn("HermesWorkSetupService.start")(function* (
      input: HermesWorkSetupInput,
    ) {
      const previous = states.get(input.providerInstanceId);
      if (previous && active(previous)) return previous;
      const state = report(
        input.providerInstanceId,
        "installing",
        "Looking for Hermes and installing it if needed.",
      );
      const fiber = yield* run(input.providerInstanceId).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const error = Cause.findErrorOption(cause);
            const message =
              Option.isSome(error) && isWorkError(error.value)
                ? error.value.message
                : "Hermes setup could not finish. Check the environment connection and retry.";
            report(
              input.providerInstanceId,
              "error",
              message,
              states.get(input.providerInstanceId)?.model ?? null,
            );
          }),
        ),
        Effect.asVoid,
        Effect.forkIn(scope),
      );
      operations.set(input.providerInstanceId, fiber);
      return state;
    }, gate.withPermit);
    const status = (input: HermesWorkSetupInput) =>
      Effect.sync(() => states.get(input.providerInstanceId) ?? idle(input.providerInstanceId));
    const wait = Effect.fn("HermesWorkSetupService.wait")(function* (input: HermesWorkSetupInput) {
      const fiber = operations.get(input.providerInstanceId);
      if (fiber) yield* Fiber.join(fiber);
      return yield* status(input);
    });
    return HermesWorkSetupService.of({ start, status, wait });
  });
export const hermesWorkSetupServiceLayer = Layer.effect(
  HermesWorkSetupService,
  makeHermesWorkSetupService(),
);
