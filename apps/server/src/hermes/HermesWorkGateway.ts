import { HermesWorkError } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import type { HermesDashboardClient } from "./HermesDashboardClient.ts";
import { hermesProcessDiagnostic } from "./HermesProcessDiagnostic.ts";

const decodeStatus = Schema.decodeUnknownEffect(
  Schema.Struct({
    gateway_running: Schema.Boolean,
    gateway_state: Schema.optional(Schema.NullOr(Schema.String)),
    gateway_exit_reason: Schema.optional(Schema.NullOr(Schema.String)),
    components: Schema.optional(
      Schema.Struct({
        gateway: Schema.optional(
          Schema.Struct({ state: Schema.optional(Schema.NullOr(Schema.String)) }),
        ),
      }),
    ),
  }),
);
const decodeStart = Schema.decodeUnknownEffect(
  Schema.Struct({ ok: Schema.Boolean, pid: Schema.Number, name: Schema.String }),
);
const decodeAction = Schema.decodeUnknownEffect(
  Schema.Struct({
    running: Schema.Boolean,
    exit_code: Schema.NullOr(Schema.Number),
    pid: Schema.NullOr(Schema.Number),
    lines: Schema.Array(Schema.String),
  }),
);
const isWorkError = Schema.is(HermesWorkError);
const invalidResponse = () =>
  new HermesWorkError({
    code: "invalid_response",
    message: "Hermes returned an invalid background-service response.",
  });
type Scope = { readonly providerInstanceId: string; readonly profile: string };
export const readHermesWorkGateway = Effect.fn("readHermesWorkGateway")(function* (
  dashboard: HermesDashboardClient["Service"],
  scope: Scope,
) {
  const payload = yield* dashboard.request({ ...scope, method: "GET", path: "/api/status" });
  const status = yield* decodeStatus(payload).pipe(Effect.mapError(invalidResponse));
  return {
    running: status.gateway_running,
    state:
      status.gateway_state ||
      status.components?.gateway?.state ||
      (status.gateway_running ? "running" : "stopped"),
    exitReason: status.gateway_exit_reason ?? null,
  };
});

/** A launch receipt only confirms spawning; success requires native gateway liveness. */
export const startHermesWorkGateway = Effect.fn("startHermesWorkGateway")(
  function* (
    dashboard: HermesDashboardClient["Service"],
    scope: Scope,
    options: { readonly attempts?: number; readonly wait?: Effect.Effect<void> } = {},
  ) {
    const before = yield* readHermesWorkGateway(dashboard, scope);
    if (before.running) return before;
    const receipt = yield* dashboard
      .request({ ...scope, method: "POST", path: "/api/gateway/start" })
      .pipe(
        Effect.flatMap(decodeStart),
        Effect.mapError((error) => (isWorkError(error) ? error : invalidResponse())),
      );
    if (!receipt.ok)
      return yield* new HermesWorkError({
        code: "unavailable",
        message: "Hermes did not accept background-service startup.",
      });
    let detail = "The gateway did not become available.";
    for (let attempt = 0; attempt < (options.attempts ?? 45); attempt++) {
      const status = yield* readHermesWorkGateway(dashboard, scope);
      if (status.running) return status;
      const action = yield* dashboard
        .request({
          ...scope,
          method: "GET",
          path: `/api/actions/${encodeURIComponent(receipt.name)}/status`,
          query: { lines: 60 },
        })
        .pipe(
          Effect.flatMap(decodeAction),
          Effect.mapError((error) => (isWorkError(error) ? error : invalidResponse())),
        );
      if (action.pid !== null && action.pid !== receipt.pid)
        return yield* new HermesWorkError({
          code: "conflict",
          message:
            "Another Hermes gateway operation replaced this startup request. Check its current status.",
        });
      const marker = action.lines.findLastIndex((line) =>
        line.startsWith(`=== ${receipt.name} started`),
      );
      const lines = marker < 0 ? action.lines : action.lines.slice(marker + 1);
      detail = hermesProcessDiagnostic(lines.join("\n")) || status.exitReason || detail;
      if (
        (!action.running && action.exit_code !== null && action.exit_code !== 0) ||
        lines.some((line) => /refusing to|service start is not supported/iu.test(line))
      ) {
        return yield* new HermesWorkError({
          code: "unavailable",
          message: `Hermes background scheduling could not start. ${detail}`,
        });
      }
      if (attempt + 1 < (options.attempts ?? 45)) yield* options.wait ?? Effect.sleep("1 second");
    }
    return yield* new HermesWorkError({
      code: "unavailable",
      message: `Hermes background scheduling did not become ready. ${detail}`,
    });
  },
  Effect.timeout("60 seconds"),
  Effect.catchTag("TimeoutError", () =>
    Effect.fail(
      new HermesWorkError({
        code: "unavailable",
        message: "Hermes background scheduling did not confirm startup within one minute.",
      }),
    ),
  ),
);
