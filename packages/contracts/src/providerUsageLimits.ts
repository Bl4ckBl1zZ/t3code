import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const ServerProviderUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

export const ServerProviderResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.optional(IsoDateTime),
});
export type ServerProviderResetCredits = typeof ServerProviderResetCredits.Type;

/** Optional snapshot enrichment. Failed probes never imply an unused allowance. */
export const ServerProviderUsageLimits = Schema.Struct({
  checkedAt: IsoDateTime,
  windows: ForwardCompatibleArray(ServerProviderUsageWindow),
  resetCredits: Schema.optional(ServerProviderResetCredits),
  unavailable: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["unsupported", "probeFailed"]),
      message: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ServerProviderUsageLimits = typeof ServerProviderUsageLimits.Type;

export const ProviderConsumeResetCreditInput = Schema.Struct({ instanceId: ProviderInstanceId });
export type ProviderConsumeResetCreditInput = typeof ProviderConsumeResetCreditInput.Type;
export const ProviderConsumeResetCreditOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type ProviderConsumeResetCreditOutcome = typeof ProviderConsumeResetCreditOutcome.Type;
export const ProviderConsumeResetCreditResult = Schema.Struct({
  outcome: ProviderConsumeResetCreditOutcome,
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderConsumeResetCreditResult = typeof ProviderConsumeResetCreditResult.Type;

/** Account setup/action failure shared with newer provider clients. */
export class ProviderSetupError extends Schema.TaggedErrorClass<ProviderSetupError>()(
  "ProviderSetupError",
  {
    instanceId: ProviderInstanceId,
    operation: Schema.String,
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
