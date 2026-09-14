import * as Schema from "effect/Schema";

const scope = { providerInstanceId: Schema.String, profile: Schema.optional(Schema.String) };
export const HermesWorkModelStatusInput = Schema.Struct(scope);
export type HermesWorkModelStatusInput = typeof HermesWorkModelStatusInput.Type;
export const HermesWorkModelStatus = Schema.Struct({
  model: Schema.String,
  provider: Schema.String,
  ready: Schema.Boolean,
  providers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      authenticated: Schema.Boolean,
      models: Schema.Array(Schema.String),
    }),
  ),
  accounts: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      flow: Schema.String,
      loggedIn: Schema.Boolean,
      sourceLabel: Schema.NullOr(Schema.String),
    }),
  ),
});
export type HermesWorkModelStatus = typeof HermesWorkModelStatus.Type;
export const HermesWorkModelAuthStartInput = Schema.Struct({ ...scope, provider: Schema.String });
export type HermesWorkModelAuthStartInput = typeof HermesWorkModelAuthStartInput.Type;
export const HermesWorkModelAuthStartResult = Schema.Struct({
  sessionId: Schema.String,
  userCode: Schema.String,
  verificationUrl: Schema.String,
  expiresIn: Schema.Number,
  pollInterval: Schema.Number,
});
export type HermesWorkModelAuthStartResult = typeof HermesWorkModelAuthStartResult.Type;
export const HermesWorkModelAuthPollInput = Schema.Struct({
  ...scope,
  provider: Schema.String,
  sessionId: Schema.String,
});
export type HermesWorkModelAuthPollInput = typeof HermesWorkModelAuthPollInput.Type;
export const HermesWorkModelAuthPollResult = Schema.Struct({
  status: Schema.Literals(["pending", "approved", "denied", "expired", "error"]),
  message: Schema.NullOr(Schema.String),
});
export type HermesWorkModelAuthPollResult = typeof HermesWorkModelAuthPollResult.Type;
export const HermesWorkModelAuthCancelInput = Schema.Struct({ ...scope, sessionId: Schema.String });
export type HermesWorkModelAuthCancelInput = typeof HermesWorkModelAuthCancelInput.Type;
export const HermesWorkModelSetInput = Schema.Struct({
  ...scope,
  provider: Schema.String,
  model: Schema.String,
  confirmExpensiveModel: Schema.optional(Schema.Boolean),
});
export type HermesWorkModelSetInput = typeof HermesWorkModelSetInput.Type;
export const HermesWorkModelSetResult = Schema.Struct({
  ok: Schema.Boolean,
  confirmRequired: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});
export type HermesWorkModelSetResult = typeof HermesWorkModelSetResult.Type;
