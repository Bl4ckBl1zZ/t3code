import { it, expect } from "@effect/vitest";
import { Deferred, Effect, Layer, Path, Schema } from "effect";
import { HermesSettings, HermesWorkError, ProviderInstanceId } from "@t3tools/contracts";
import * as ServerSettings from "../serverSettings.ts";
import { HermesDashboardClient } from "./HermesDashboardClient.ts";
import { HermesWorkModelAuth } from "./HermesWorkModelAuth.ts";
import { HermesWorkInstaller } from "./HermesWorkInstaller.ts";
import { makeHermesWorkSetupService } from "./HermesWorkSetupService.ts";

const target = { providerInstanceId: "hermes" };
const modelOptions = { model: "", provider: "", providers: [] };
const decodeHermesSettings = Schema.decodeUnknownSync(HermesSettings);
const hermesSettings = decodeHermesSettings({});
const make = (
  settingsLayer: ReturnType<typeof ServerSettings.layerTest>,
  options: {
    model: string;
    provider: string;
    providers: { slug: string; authenticated?: boolean }[];
  } = modelOptions,
  failInstall = false,
  installationGate?: Deferred.Deferred<void>,
) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    let installs = 0;
    const service = yield* makeHermesWorkSetupService({
      localEndpoint: () => Promise.resolve("ws://127.0.0.1:43210/api/ws"),
    }).pipe(
      Effect.provideService(HermesWorkModelAuth, {
        modelStatus: () =>
          Effect.succeed({
            model: options.model,
            provider: options.provider,
            ready:
              Boolean(options.model) &&
              options.providers.some(
                (provider) => provider.slug === options.provider && provider.authenticated === true,
              ),
            providers: [],
            accounts: [],
          }),
        modelAuthStart: () => Effect.die("unused"),
        modelAuthPoll: () => Effect.die("unused"),
        modelAuthCancel: () => Effect.die("unused"),
        modelSet: () => Effect.die("unused"),
      }),
      Effect.provideService(HermesWorkInstaller, {
        ensureInstalled: () =>
          Effect.gen(function* () {
            installs++;
            if (installationGate) yield* Deferred.await(installationGate);
            if (failInstall)
              return yield* new HermesWorkError({
                code: "unavailable",
                message: "Installation failed.",
              });
            return { binaryPath: "/test/local/bin/hermes", installed: true };
          }),
      }),
      Effect.provideService(HermesDashboardClient, {
        connections: () => Effect.succeed({ connections: [] }),
        connection: () =>
          Effect.succeed({
            providerInstanceId: "hermes",
            displayName: "Hermes",
            profileKey: "default",
            endpoint: "ws://127.0.0.1:43210/api/ws",
            token: "test",
            settings: hermesSettings,
          }),
        request: () => Effect.succeed({ gateway_running: true, gateway_state: "running" }),
      }),
    );
    return { service, settings, installs: () => installs };
  }).pipe(Effect.provide(Layer.merge(settingsLayer, Path.layer)));

it.effect(
  "configures both enable flags, a sensitive token and executable PATH before connecting",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, settings } = yield* make(ServerSettings.layerTest({}));
        expect((yield* service.start(target)).phase).toBe("installing");
        expect((yield* service.wait(target)).phase).toBe("needs_model");
        const saved = yield* settings.getSettings;
        const instance = saved.providerInstances[ProviderInstanceId.make("hermes")];
        expect(saved.enableHermes).toBe(true);
        expect(saved.providers.hermes.enabled).toBe(true);
        expect(instance?.enabled).toBe(true);
        expect(
          instance?.environment?.find((entry) => entry.name === "HERMES_GATEWAY_TOKEN"),
        ).toMatchObject({ sensitive: true });
        expect(
          instance?.environment
            ?.find((entry) => entry.name === "PATH")
            ?.value.startsWith("/test/local/bin"),
        ).toBe(true);
        expect(instance?.config).toMatchObject({
          endpoint: "ws://127.0.0.1:43210/api/ws",
          managedServerEnabled: true,
        });
      }),
    ),
);
it.effect("preserves an existing remote endpoint and token without invoking an installer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { service, settings, installs } = yield* make(
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("hermes")]: {
              driver: "hermes",
              config: { endpoint: "wss://hermes.example/api/ws" },
              environment: [{ name: "HERMES_GATEWAY_TOKEN", value: "existing", sensitive: true }],
            },
          },
        }),
        {
          model: "model-one",
          provider: "provider-one",
          providers: [{ slug: "provider-one", authenticated: true }],
        },
      );
      yield* service.start(target);
      expect((yield* service.wait(target)).phase).toBe("connected");
      expect(installs()).toBe(0);
      const saved = yield* settings.getSettings;
      expect(saved.providerInstances[ProviderInstanceId.make("hermes")]?.config).toMatchObject({
        endpoint: "wss://hermes.example/api/ws",
      });
      expect(
        saved.providerInstances[ProviderInstanceId.make("hermes")]?.environment?.find(
          (entry) => entry.name === "HERMES_GATEWAY_TOKEN",
        )?.value,
      ).toBe("existing");
    }),
  ),
);
it.effect("deduplicates active setup and exposes failure without enabling unusable settings", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const { service, settings, installs } = yield* make(
        ServerSettings.layerTest({}),
        modelOptions,
        true,
        release,
      );
      yield* service.start(target);
      yield* service.start(target);
      yield* Deferred.succeed(release, undefined);
      const result = yield* service.wait(target);
      expect(result).toMatchObject({ phase: "error", message: "Installation failed." });
      expect(installs()).toBe(1);
      expect((yield* settings.getSettings).enableHermes).toBe(false);
    }),
  ),
);
it.effect("does not claim model readiness from an unauthenticated configured model", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { service } = yield* make(ServerSettings.layerTest({}), {
        model: "configured",
        provider: "missing",
        providers: [{ slug: "missing", authenticated: false }],
      });
      yield* service.start(target);
      expect((yield* service.wait(target)).phase).toBe("needs_model");
    }),
  ),
);
