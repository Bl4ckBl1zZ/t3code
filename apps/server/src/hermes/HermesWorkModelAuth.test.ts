import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HermesSettings } from "@t3tools/contracts";
import { HermesDashboardClient, type HermesDashboardRequest } from "./HermesDashboardClient.ts";
import { makeHermesWorkModelAuth } from "./HermesWorkModelAuth.ts";

const decodeHermesSettings = Schema.decodeUnknownSync(HermesSettings);
const input = { providerInstanceId: "hermes", profile: "research" };
const catalog = {
  providers: [
    {
      id: "openai-codex",
      name: "OpenAI",
      flow: "device_code",
      status: { logged_in: true, source_label: "Existing credentials" },
    },
  ],
};
const fixture = (respond: (request: HermesDashboardRequest) => unknown) =>
  makeHermesWorkModelAuth.pipe(
    Effect.provideService(
      HermesDashboardClient,
      HermesDashboardClient.of({
        request: (request) => Effect.sync(() => respond(request)),
        connection: () =>
          Effect.succeed({
            providerInstanceId: "hermes",
            displayName: "Hermes",
            profileKey: "research",
            endpoint: "http://localhost:1",
            token: "fixture",
            settings: decodeHermesSettings({}),
          }),
        connections: () => Effect.succeed({ connections: [] }),
      }),
    ),
  );

describe("Hermes native model setup", () => {
  it.effect("scopes all setup operations to the configured profile when omitted", () =>
    Effect.gen(function* () {
      const calls: HermesDashboardRequest[] = [];
      const service = yield* fixture((request) => {
        calls.push(request);
        if (request.path === "/api/model/info")
          return { model: "gpt-model", provider: "openai-codex" };
        if (request.path === "/api/model/options")
          return {
            providers: [
              { slug: "openai-codex", name: "OpenAI", authenticated: true, models: ["gpt-model"] },
            ],
          };
        if (request.path === "/api/providers/oauth") return catalog;
        if (request.path.endsWith("/start"))
          return {
            session_id: "session",
            flow: "device_code",
            user_code: "ABCD",
            verification_url: "https://auth.openai.com/device",
            expires_in: 900,
            poll_interval: 5,
          };
        if (request.path.includes("/poll/")) return { status: "approved" };
        return { ok: true };
      });
      const setup = { providerInstanceId: "hermes" };
      yield* service.modelStatus(setup);
      yield* service.modelAuthStart({ ...setup, provider: "openai-codex" });
      yield* service.modelAuthPoll({ ...setup, provider: "openai-codex", sessionId: "session" });
      yield* service.modelAuthCancel({ ...setup, sessionId: "session" });
      yield* service.modelSet({ ...setup, provider: "openai-codex", model: "gpt-model" });
      expect(calls).toHaveLength(8);
      expect(calls.every((request) => request.profile === "research")).toBe(true);
      calls.length = 0;
      yield* service.modelStatus({ ...setup, profile: "other" });
      expect(calls.every((request) => request.profile === "other")).toBe(true);
    }),
  );
  it.effect("uses Hermes current-provider resolution for configured aliases", () =>
    Effect.gen(function* () {
      const service = yield* fixture((request) =>
        request.path === "/api/model/info"
          ? { model: "local-model", provider: "My endpoint" }
          : request.path === "/api/model/options"
            ? {
                providers: [
                  {
                    slug: "custom-endpoint",
                    name: "My endpoint",
                    models: ["local-model"],
                    authenticated: true,
                    is_current: true,
                  },
                ],
              }
            : catalog,
      );
      expect((yield* service.modelStatus(input)).ready).toBe(true);
    }),
  );
  it.effect("reuses existing credentials only when the configured provider is authenticated", () =>
    Effect.gen(function* () {
      let authenticated = false;
      const service = yield* fixture((request) =>
        request.path === "/api/model/info"
          ? { model: "gpt-model", provider: "openai-codex" }
          : request.path === "/api/model/options"
            ? {
                providers: [
                  { slug: "openai-codex", name: "OpenAI", models: ["gpt-model"], authenticated },
                ],
              }
            : catalog,
      );
      expect((yield* service.modelStatus(input)).ready).toBe(false);
      authenticated = true;
      const state = yield* service.modelStatus(input);
      expect(state.ready).toBe(true);
      expect(state.accounts[0]?.sourceLabel).toBe("Existing credentials");
    }),
  );
  it.effect("returns native device details without opening a browser or leaking token fields", () =>
    Effect.gen(function* () {
      const calls: HermesDashboardRequest[] = [];
      const service = yield* fixture((request) => {
        calls.push(request);
        return request.path === "/api/providers/oauth"
          ? catalog
          : {
              session_id: "session",
              flow: "device_code",
              user_code: "ABCD",
              verification_url: "https://auth.openai.com/device",
              expires_in: 900,
              poll_interval: 5,
              access_token: "must-not-escape",
            };
      });
      expect(yield* service.modelAuthStart({ ...input, provider: "openai-codex" })).toEqual({
        sessionId: "session",
        userCode: "ABCD",
        verificationUrl: "https://auth.openai.com/device",
        expiresIn: 900,
        pollInterval: 5,
      });
      expect(calls.at(-1)).toMatchObject({
        profile: "research",
        method: "POST",
        path: "/api/providers/oauth/openai-codex/start",
      });
    }),
  );
  it.effect("rejects external flows without starting an OAuth session", () =>
    Effect.gen(function* () {
      const calls: HermesDashboardRequest[] = [];
      const service = yield* fixture((request) => {
        calls.push(request);
        return {
          providers: [
            { id: "external", name: "External", flow: "external", status: { logged_in: false } },
          ],
        };
      });
      const error = yield* service
        .modelAuthStart({ ...input, provider: "external" })
        .pipe(Effect.flip);
      expect(error.code).toBe("unsupported");
      expect(calls).toHaveLength(1);
    }),
  );
  it.effect("preserves native model price confirmation without silently confirming it", () =>
    Effect.gen(function* () {
      const calls: HermesDashboardRequest[] = [];
      const service = yield* fixture((request) => {
        calls.push(request);
        return { ok: false, confirm_required: true, confirm_message: "Expensive model" };
      });
      expect(
        yield* service.modelSet({ ...input, provider: "openai-codex", model: "gpt-model" }),
      ).toEqual({ ok: false, confirmRequired: true, message: "Expensive model" });
      expect(calls[0]?.body).toEqual({
        scope: "main",
        provider: "openai-codex",
        model: "gpt-model",
        confirm_expensive_model: false,
      });
    }),
  );
  it.effect("polls and cancels within the same profile", () =>
    Effect.gen(function* () {
      const calls: HermesDashboardRequest[] = [];
      const service = yield* fixture((request) => {
        calls.push(request);
        return request.method === "DELETE"
          ? { ok: true }
          : { status: "denied", error_message: "Declined" };
      });
      expect(
        yield* service.modelAuthPoll({ ...input, provider: "openai-codex", sessionId: "session" }),
      ).toEqual({ status: "denied", message: "Declined" });
      expect(yield* service.modelAuthCancel({ ...input, sessionId: "session" })).toEqual({
        ok: true,
      });
      expect(calls.map((call) => call.profile)).toEqual(["research", "research"]);
    }),
  );
});
