import { ProviderSetupError, type ProviderConsumeResetCreditInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ProviderInstance } from "./ProviderDriver.ts";

/** Validate the current instance immediately before an account-level operation. */
export const consumeInstanceResetCredit = Effect.fn("consumeInstanceResetCredit")(function* (
  instance: Pick<ProviderInstance, "enabled" | "consumeResetCredit"> | undefined,
  input: ProviderConsumeResetCreditInput,
) {
  if (!instance?.enabled || !instance.consumeResetCredit)
    return yield* new ProviderSetupError({
      instanceId: input.instanceId,
      operation: "consume-reset-credit",
      detail: !instance
        ? "Provider instance not found."
        : !instance.enabled
          ? "This provider is disabled."
          : "This provider does not bank reset credits.",
    });
  return yield* instance.consumeResetCredit().pipe(
    Effect.mapError(
      (error) =>
        new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "consume-reset-credit",
          detail: error.detail,
          cause: error,
        }),
    ),
  );
});
