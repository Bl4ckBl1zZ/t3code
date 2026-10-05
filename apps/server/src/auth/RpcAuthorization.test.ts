import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/unstable/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  rpcScopeAuthorizationLayer,
} from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("requires permission to operate on a thread before uploading feedback", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerUploadFeedback)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("separates reading Hermes work from changing assistants or schedules", () => {
    for (const method of [
      WS_METHODS.hermesWorkSetupStatus,
      WS_METHODS.hermesWorkModelStatus,
      WS_METHODS.hermesWorkConnections,
      WS_METHODS.hermesWorkQuery,
      WS_METHODS.hermesWorkSubscribeChanges,
      WS_METHODS.hermesWorkGroupsQuery,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
    for (const method of [
      WS_METHODS.hermesWorkMutate,
      WS_METHODS.hermesWorkGroupsMutate,
      WS_METHODS.hermesWorkSetupStart,
      WS_METHODS.hermesWorkModelAuthStart,
      WS_METHODS.hermesWorkModelAuthPoll,
      WS_METHODS.hermesWorkModelAuthCancel,
      WS_METHODS.hermesWorkModelSet,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

describe("RPC scope middleware", () => {
  // Upstream RPCs plus fork-only Hermes RPCs, effect and stream.
  const tested = [
    WS_METHODS.serverProbe,
    WS_METHODS.serverRetryResourceTelemetry,
    WS_METHODS.hermesWorkSetupStart,
    WS_METHODS.hermesWorkSubscribeChanges,
  ] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect("checks each RPC's declared scope before its handler runs", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            group.toLayerHandler(WS_METHODS.hermesWorkSetupStart, () =>
              Effect.sync(() => handled.push("hermes-setup")).pipe(Effect.andThen(Effect.never)),
            ),
            group.toLayerHandler(WS_METHODS.hermesWorkSubscribeChanges, (input) =>
              Stream.make({
                providerInstanceId: input.providerInstanceId,
                kind: "reconnected" as const,
              }),
            ),
            rpcScopeAuthorizationLayer([AuthOrchestrationReadScope]),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationOperateScope,
      });
      expect(
        yield* client[WS_METHODS.hermesWorkSetupStart]({ providerInstanceId: "hermes" }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationOperateScope,
      });
      expect(
        yield* client[WS_METHODS.hermesWorkSubscribeChanges]({ providerInstanceId: "hermes" }).pipe(
          Stream.runCollect,
        ),
      ).toEqual([{ providerInstanceId: "hermes", kind: "reconnected" }]);
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
