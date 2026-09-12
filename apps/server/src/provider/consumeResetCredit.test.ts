import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverError } from "./Errors.ts";
import { consumeInstanceResetCredit } from "./consumeResetCredit.ts";
const input = { instanceId: ProviderInstanceId.make("work") };
describe("reset credit dispatch", () => {
  it.effect("rejects missing, disabled and unsupported accounts without redeeming", () =>
    Effect.gen(function* () {
      let calls = 0;
      const consumeResetCredit = () =>
        Effect.sync(() => {
          calls++;
          return { outcome: "reset" as const };
        });
      for (const instance of [
        undefined,
        { enabled: false, consumeResetCredit },
        { enabled: true },
      ]) {
        const result = yield* consumeInstanceResetCredit(instance, input).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.instanceId).toBe("work");
      }
      expect(calls).toBe(0);
    }),
  );
  it.effect("keeps an applied outcome and refresh warning successful", () =>
    Effect.gen(function* () {
      const expected = { outcome: "reset" as const, warning: "Refresh to check new limits." };
      const actual = yield* consumeInstanceResetCredit(
        { enabled: true, consumeResetCredit: () => Effect.succeed(expected) },
        input,
      );
      expect(actual).toEqual(expected);
    }),
  );
  it.effect("preserves the account and actionable error when redemption fails", () =>
    Effect.gen(function* () {
      const result = yield* consumeInstanceResetCredit(
        {
          enabled: true,
          consumeResetCredit: () =>
            Effect.fail(
              new ProviderDriverError({
                driver: ProviderDriverKind.make("codex"),
                instanceId: input.instanceId,
                detail: "Retry this attempt.",
              }),
            ),
        },
        input,
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          instanceId: "work",
          operation: "consume-reset-credit",
          detail: "Retry this attempt.",
        });
    }),
  );
});
