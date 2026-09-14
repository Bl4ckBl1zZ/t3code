import { HermesWorkError, ProviderInstanceId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import {
  HermesDashboardClient,
  makeHermesDashboardClient,
  type HermesDashboardClientOptions,
} from "./HermesDashboardClient.ts";

const settings = ServerSettings.layerTest({
  enableHermes: true,
  providerInstances: {
    [ProviderInstanceId.make("hermes_main")]: {
      driver: "hermes",
      displayName: "Work",
      enabled: true,
      environment: [{ name: "HERMES_GATEWAY_TOKEN", value: "secret", sensitive: true }],
      config: { endpoint: "ws://127.0.0.1:9119/api/ws", profileKey: "default" },
    },
  },
});
const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => error,
      onSuccess: () => {
        throw new Error("Expected failure");
      },
    }),
  );
const run = (options: HermesDashboardClientOptions, method: "GET" | "POST" = "GET") =>
  Effect.gen(function* () {
    const client = yield* HermesDashboardClient;
    return yield* client.request({
      providerInstanceId: "hermes_main",
      method,
      path: "/api/cron/jobs",
      profile: "research",
      ...(method === "POST" ? { body: { prompt: "Check hourly" } } : {}),
    });
  }).pipe(
    Effect.provide(
      Layer.effect(HermesDashboardClient, makeHermesDashboardClient(options)).pipe(
        Layer.provide(settings),
      ),
    ),
  );

describe("HermesDashboardClient", () => {
  it.effect("does not dispatch a request when the managed runtime cannot start", () =>
    Effect.gen(function* () {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const error = yield* failureOf(
        run({
          fetch,
          ensureReady: () =>
            Effect.fail(new HermesWorkError({ code: "unavailable", message: "Start failed." })),
        }),
      );
      expect(error).toMatchObject({ code: "unavailable" });
      expect(fetch).not.toHaveBeenCalled();
    }),
  );
  it.live("uses the native serve origin, bearer auth and explicit profile", () =>
    Effect.gen(function* () {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ jobs: [] }));
      expect(yield* run({ fetch })).toEqual({ jobs: [] });
      const [url, init] = fetch.mock.calls[0]!;
      expect(String(url)).toBe("http://127.0.0.1:9119/api/cron/jobs?profile=research");
      expect(init).toMatchObject({
        headers: { Authorization: "Bearer secret" },
        redirect: "error",
      });
    }),
  );
  it.live("does not leak upstream authentication errors", () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response("secret upstream details", { status: 401 }));
      expect(yield* failureOf(run({ fetch }))).toMatchObject({ code: "unauthorized" });
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
  );
  it.live("reports unsupported endpoints", () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(null, { status: 405 }));
      expect(yield* failureOf(run({ fetch }))).toMatchObject({ code: "unsupported" });
    }),
  );
  it.live("distinguishes invalid responses from connection failures", () =>
    Effect.gen(function* () {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("not json"));
      expect(yield* failureOf(run({ fetch }))).toMatchObject({ code: "invalid_response" });
    }),
  );
  it.live("does not mistake a failed mutation confirmation for a safe retry", () =>
    Effect.gen(function* () {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("not json"));
      expect(yield* failureOf(run({ fetch }, "POST"))).toMatchObject({ code: "indeterminate" });
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
  );
  it.live("never retries a mutation whose response is lost", () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(new Error("connection lost"));
      expect(yield* failureOf(run({ fetch }, "POST"))).toMatchObject({ code: "indeterminate" });
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
  );
  it.live("aborts a timed out mutation and reports its uncertain outcome without retrying", () =>
    Effect.gen(function* () {
      let signal: AbortSignal | null | undefined;
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
        signal = init?.signal;
        return new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      });
      expect(yield* failureOf(run({ fetch, timeoutMs: 10 }, "POST"))).toMatchObject({
        code: "indeterminate",
      });
      expect(signal?.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
  );
});
