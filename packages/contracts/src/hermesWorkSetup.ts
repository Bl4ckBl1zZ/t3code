import * as Schema from "effect/Schema";

export const HermesWorkSetupInput = Schema.Struct({ providerInstanceId: Schema.String });
export type HermesWorkSetupInput = typeof HermesWorkSetupInput.Type;
export const HermesWorkSetupState = Schema.Struct({
  providerInstanceId: Schema.String,
  phase: Schema.Literals([
    "idle",
    "installing",
    "configuring",
    "connecting",
    "needs_model",
    "connected",
    "error",
  ]),
  message: Schema.String,
  model: Schema.NullOr(Schema.String),
});
export type HermesWorkSetupState = typeof HermesWorkSetupState.Type;
