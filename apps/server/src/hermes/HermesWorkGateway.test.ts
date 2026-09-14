import { it, expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HermesDashboardClient, HermesDashboardRequest } from "./HermesDashboardClient.ts";
import { readHermesWorkGateway, startHermesWorkGateway } from "./HermesWorkGateway.ts";

const scope = { providerInstanceId: "hermes", profile: "default" };
const dashboard = (
  respond: (request: HermesDashboardRequest) => unknown,
): HermesDashboardClient["Service"] => ({
  connections: () => Effect.succeed({ connections: [] }),
  connection: () => Effect.die("unused"),
  request: (request) => Effect.sync(() => respond(request)),
});
it.effect("uses native component fallback instead of displaying a null gateway state", () =>
  Effect.gen(function* () {
    const result = yield* readHermesWorkGateway(
      dashboard(() => ({
        gateway_running: false,
        gateway_state: null,
        components: { gateway: { state: "stopped" } },
      })),
      scope,
    );
    expect(result).toEqual({ running: false, state: "stopped", exitReason: null });
  }),
);
it.effect(
  "waits beyond a successful spawn receipt until native gateway liveness is confirmed",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      let starts = 0;
      const client = dashboard((request) => {
        if (request.path === "/api/status")
          return { gateway_running: ++reads >= 3, gateway_state: reads >= 3 ? "running" : null };
        if (request.path === "/api/gateway/start") {
          starts++;
          return { ok: true, name: "gateway-start", pid: 42 };
        }
        return { running: false, exit_code: 0, pid: 42, lines: ["Service started"] };
      });
      const result = yield* startHermesWorkGateway(client, scope, {
        attempts: 3,
        wait: Effect.void,
      });
      expect(result.running).toBe(true);
      expect(starts).toBe(1);
      expect(reads).toBe(3);
    }),
);
it.effect("reports native refusal even when the command misleadingly exits successfully", () =>
  Effect.gen(function* () {
    const client = dashboard((request) =>
      request.path === "/api/status"
        ? { gateway_running: false, gateway_state: null }
        : request.path === "/api/gateway/start"
          ? { ok: true, name: "gateway-start", pid: 42 }
          : {
              running: false,
              exit_code: 0,
              pid: 42,
              lines: [
                "=== gateway-start started now ===",
                "Refusing to write the gateway launchd plist: HERMES_HOME is temporary.",
                "✓ Service started",
              ],
            },
    );
    const error = yield* startHermesWorkGateway(client, scope, {
      attempts: 2,
      wait: Effect.void,
    }).pipe(Effect.flip);
    expect(error.message).toContain("Refusing to write");
  }),
);
it.effect("bounds confirmation attempts and never treats a receipt as running", () =>
  Effect.gen(function* () {
    let reads = 0;
    const client = dashboard((request) => {
      if (request.path === "/api/status") {
        reads++;
        return { gateway_running: false, gateway_state: null };
      }
      if (request.path === "/api/gateway/start")
        return { ok: true, name: "gateway-start", pid: 42 };
      return { running: false, exit_code: 0, pid: 42, lines: [] };
    });
    const error = yield* startHermesWorkGateway(client, scope, {
      attempts: 2,
      wait: Effect.void,
    }).pipe(Effect.flip);
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("did not become ready");
    expect(reads).toBe(3);
  }),
);
