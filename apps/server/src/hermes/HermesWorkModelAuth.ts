import { Context, Effect, Layer, Schema } from "effect";
import { HermesWorkError } from "@t3tools/contracts";
import type {
  HermesWorkModelStatusInput,
  HermesWorkModelAuthStartInput,
  HermesWorkModelAuthPollInput,
  HermesWorkModelAuthCancelInput,
  HermesWorkModelSetInput,
} from "@t3tools/contracts";
import { HermesDashboardClient } from "./HermesDashboardClient.ts";

const info = Schema.decodeUnknownEffect(
  Schema.Struct({ model: Schema.String, provider: Schema.String }),
);
const options = Schema.decodeUnknownEffect(
  Schema.Struct({
    providers: Schema.Array(
      Schema.Struct({
        slug: Schema.String,
        name: Schema.String,
        authenticated: Schema.Boolean,
        is_current: Schema.optional(Schema.Boolean),
        models: Schema.Array(Schema.String),
      }),
    ),
  }),
);
const accounts = Schema.decodeUnknownEffect(
  Schema.Struct({
    providers: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        flow: Schema.String,
        status: Schema.Struct({
          logged_in: Schema.Boolean,
          source_label: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      }),
    ),
  }),
);
const started = Schema.decodeUnknownEffect(
  Schema.Struct({
    session_id: Schema.String,
    flow: Schema.Literal("device_code"),
    user_code: Schema.String,
    verification_url: Schema.String,
    expires_in: Schema.Number,
    poll_interval: Schema.Number,
  }),
);
const polled = Schema.decodeUnknownEffect(
  Schema.Struct({
    status: Schema.Literals(["pending", "approved", "denied", "expired", "error"]),
    error_message: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const confirmation = Schema.decodeUnknownEffect(
  Schema.Struct({
    ok: Schema.Boolean,
    confirm_required: Schema.optional(Schema.Boolean),
    confirm_message: Schema.optional(Schema.String),
  }),
);
const invalidResponse = () =>
  new HermesWorkError({
    code: "invalid_response",
    message: "Hermes returned an invalid model setup response.",
  });

export const makeHermesWorkModelAuth = Effect.gen(function* () {
  const dashboard = yield* HermesDashboardClient;
  const requestScope = Effect.fn("HermesWorkModelAuth.requestScope")(function* (
    input: HermesWorkModelStatusInput,
  ) {
    const profile =
      input.profile ?? (yield* dashboard.connection(input.providerInstanceId)).profileKey;
    return { providerInstanceId: input.providerInstanceId, profile };
  });
  const readAccounts = Effect.fn("HermesWorkModelAuth.accounts")(function* (
    input: HermesWorkModelStatusInput,
  ) {
    const scope = yield* requestScope(input);
    return yield* dashboard
      .request({ ...scope, method: "GET", path: "/api/providers/oauth" })
      .pipe(Effect.flatMap((value) => accounts(value).pipe(Effect.mapError(invalidResponse))));
  });
  const modelStatus = Effect.fn("HermesWorkModelAuth.modelStatus")(function* (
    input: HermesWorkModelStatusInput,
  ) {
    const scope = yield* requestScope(input);
    const current = yield* dashboard
      .request({ ...scope, method: "GET", path: "/api/model/info" })
      .pipe(Effect.flatMap((value) => info(value).pipe(Effect.mapError(invalidResponse))));
    const available = yield* dashboard
      .request({
        ...scope,
        method: "GET",
        path: "/api/model/options",
        query: { include_unconfigured: true },
      })
      .pipe(Effect.flatMap((value) => options(value).pipe(Effect.mapError(invalidResponse))));
    const catalog = yield* readAccounts(scope);
    return {
      ...current,
      ready:
        current.model.trim().length > 0 &&
        available.providers.some(
          (p) => (p.slug === current.provider || p.is_current === true) && p.authenticated,
        ),
      providers: available.providers.map((p) => ({
        id: p.slug,
        name: p.name,
        authenticated: p.authenticated,
        models: p.models,
      })),
      accounts: catalog.providers.map((p) => ({
        id: p.id,
        name: p.name,
        flow: p.flow,
        loggedIn: p.status.logged_in,
        sourceLabel: p.status.source_label ?? null,
      })),
    };
  });
  const modelAuthStart = Effect.fn("HermesWorkModelAuth.modelAuthStart")(function* (
    input: HermesWorkModelAuthStartInput,
  ) {
    const scope = yield* requestScope(input);
    const catalog = yield* readAccounts(scope);
    if (!catalog.providers.some((p) => p.id === input.provider && p.flow === "device_code"))
      return yield* new HermesWorkError({
        code: "unsupported",
        message: "This account requires setup through its native sign-in tool.",
      });
    const value = yield* dashboard
      .request({
        ...scope,
        method: "POST",
        path: `/api/providers/oauth/${encodeURIComponent(input.provider)}/start`,
      })
      .pipe(Effect.flatMap((value) => started(value).pipe(Effect.mapError(invalidResponse))));
    let url: URL;
    try {
      url = new URL(value.verification_url);
    } catch {
      return yield* invalidResponse();
    }
    if (url.protocol !== "https:" || url.username || url.password) return yield* invalidResponse();
    return {
      sessionId: value.session_id,
      userCode: value.user_code,
      verificationUrl: value.verification_url,
      expiresIn: value.expires_in,
      pollInterval: value.poll_interval,
    };
  });
  const modelAuthPoll = Effect.fn("HermesWorkModelAuth.modelAuthPoll")(function* (
    input: HermesWorkModelAuthPollInput,
  ) {
    const scope = yield* requestScope(input);
    const value = yield* dashboard
      .request({
        ...scope,
        method: "GET",
        path: `/api/providers/oauth/${encodeURIComponent(input.provider)}/poll/${encodeURIComponent(input.sessionId)}`,
      })
      .pipe(Effect.flatMap((value) => polled(value).pipe(Effect.mapError(invalidResponse))));
    return { status: value.status, message: value.error_message ?? null };
  });
  const modelAuthCancel = Effect.fn("HermesWorkModelAuth.modelAuthCancel")(function* (
    input: HermesWorkModelAuthCancelInput,
  ) {
    const scope = yield* requestScope(input);
    const value = yield* dashboard
      .request({
        ...scope,
        method: "DELETE",
        path: `/api/providers/oauth/sessions/${encodeURIComponent(input.sessionId)}`,
      })
      .pipe(Effect.flatMap((value) => confirmation(value).pipe(Effect.mapError(invalidResponse))));
    return { ok: value.ok };
  });
  const modelSet = Effect.fn("HermesWorkModelAuth.modelSet")(function* (
    input: HermesWorkModelSetInput,
  ) {
    const scope = yield* requestScope(input);
    if (!input.provider.trim() || !input.model.trim())
      return yield* new HermesWorkError({
        code: "invalid_input",
        message: "Choose a provider and model.",
      });
    const value = yield* dashboard
      .request({
        ...scope,
        method: "POST",
        path: "/api/model/set",
        body: {
          scope: "main",
          provider: input.provider,
          model: input.model,
          confirm_expensive_model: input.confirmExpensiveModel ?? false,
        },
      })
      .pipe(Effect.flatMap((value) => confirmation(value).pipe(Effect.mapError(invalidResponse))));
    return {
      ok: value.ok,
      confirmRequired: value.confirm_required ?? false,
      message: value.confirm_message ?? null,
    };
  });
  return { modelStatus, modelAuthStart, modelAuthPoll, modelAuthCancel, modelSet };
});

export class HermesWorkModelAuth extends Context.Service<
  HermesWorkModelAuth,
  Effect.Success<typeof makeHermesWorkModelAuth>
>()("t3/hermes/HermesWorkModelAuth") {}
export const hermesWorkModelAuthLayer = Layer.effect(HermesWorkModelAuth, makeHermesWorkModelAuth);
