import {
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  ProviderDriverKind,
  ProviderInstanceId,
  DEFAULT_SERVER_SETTINGS,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthPreviewOperateScope,
  ThreadId,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
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
      AuthEnvironmentMaintainScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
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
    for (const method of [WS_METHODS.hermesWorkMutate, WS_METHODS.hermesWorkGroupsMutate]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
    // Installing Hermes and signing its model in manage a provider.
    for (const method of [
      WS_METHODS.hermesWorkSetupStart,
      WS_METHODS.hermesWorkModelAuthStart,
      WS_METHODS.hermesWorkModelAuthPoll,
      WS_METHODS.hermesWorkModelAuthCancel,
      WS_METHODS.hermesWorkModelSet,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthProvidersManageScope);
    }
  });

  it("separates provider management and environment maintenance from operating threads", () => {
    for (const method of [
      WS_METHODS.serverUpdateProvider,
      WS_METHODS.providerAuthStart,
      WS_METHODS.providerAuthComplete,
      WS_METHODS.providerAuthRespond,
      WS_METHODS.providerAuthCancel,
      WS_METHODS.providerAuthLogout,
      WS_METHODS.providerAuthSubscribe,
      WS_METHODS.providerInstallStart,
      WS_METHODS.providerInstallCancel,
      WS_METHODS.providerInstallRemove,
      WS_METHODS.providerConsumeResetCredit,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthProvidersManageScope);
    }
    for (const method of [
      WS_METHODS.serverUpdateServer,
      WS_METHODS.serverUpdateServerWithProgress,
      WS_METHODS.serverCommitDesktopUpdate,
      WS_METHODS.serverSignalProcess,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthEnvironmentMaintainScope);
    }
    for (const method of [
      WS_METHODS.serverUpdateSettings,
      WS_METHODS.serverUpsertKeybinding,
      WS_METHODS.serverRemoveKeybinding,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthSettingsWriteScope);
    }
    // Refreshing re-reads status; any read-scoped client may ask for it.
    expect(requiredScopeForRpcMethod(WS_METHODS.serverRefreshProviders)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.providerInstallSubscribe)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("separates source control writes from reading repository state", () => {
    for (const method of [
      WS_METHODS.vcsPull,
      WS_METHODS.vcsCreateWorktree,
      WS_METHODS.vcsRemoveWorktree,
      WS_METHODS.vcsCreateRef,
      WS_METHODS.vcsSwitchRef,
      WS_METHODS.vcsInit,
      WS_METHODS.gitRunStackedAction,
      WS_METHODS.gitPreparePullRequestThread,
      WS_METHODS.sourceControlCloneRepository,
      WS_METHODS.sourceControlPublishRepository,
      WS_METHODS.pullRequestsRunAction,
      WS_METHODS.pullRequestsUpdate,
      WS_METHODS.pullRequestsComment,
      WS_METHODS.pullRequestsUpdateComment,
      WS_METHODS.pullRequestsSubmitReview,
      WS_METHODS.pullRequestsReplyToThread,
      WS_METHODS.pullRequestsSetThreadResolution,
      WS_METHODS.pullRequestsSetReaction,
      WS_METHODS.pullRequestsRequestReviewers,
      WS_METHODS.pullRequestsSetLabels,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthSourceControlWriteScope);
    }
    for (const method of [
      WS_METHODS.gitResolvePullRequest,
      WS_METHODS.vcsListRefs,
      WS_METHODS.vcsRefreshStatus,
      WS_METHODS.vcsRefreshLocalStatus,
      WS_METHODS.sourceControlLookupRepository,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });

  it("separates file access from reading threads", () => {
    for (const method of [
      WS_METHODS.projectsListEntries,
      WS_METHODS.projectsReadFile,
      WS_METHODS.projectsSearchContents,
      WS_METHODS.projectsSearchEntries,
      WS_METHODS.filesystemBrowse,
      WS_METHODS.reviewGetDiffPreview,
      WS_METHODS.reviewGetDiffFileContents,
    ]) {
      expect(requiredScopeForRpcMethod(method), method).toBe(AuthFilesystemReadScope);
    }
    expect(requiredScopeForRpcMethod(WS_METHODS.projectsWriteFile)).toBe(AuthFilesystemWriteScope);
  });

  it("separates preview control from observation", () => {
    for (const method of [
      WS_METHODS.previewOpen,
      WS_METHODS.previewNavigate,
      WS_METHODS.previewResize,
      WS_METHODS.previewRefresh,
      WS_METHODS.previewClose,
      WS_METHODS.previewReportStatus,
      WS_METHODS.previewAutomationConnect,
      WS_METHODS.previewAutomationRespond,
      WS_METHODS.previewAutomationFocusHost,
    ]) {
      expect(requiredScopeForRpcMethod(method), method).toBe(AuthPreviewOperateScope);
    }
    for (const method of [
      WS_METHODS.previewList,
      WS_METHODS.subscribePreviewEvents,
      WS_METHODS.subscribeDiscoveredLocalServers,
    ]) {
      expect(requiredScopeForRpcMethod(method), method).toBe(AuthOrchestrationReadScope);
    }
  });

  it("separates diagnostics and usage from reading threads", () => {
    for (const method of [
      WS_METHODS.serverGetTraceDiagnostics,
      WS_METHODS.serverGetProcessDiagnostics,
      WS_METHODS.serverGetProcessResourceHistory,
      WS_METHODS.serverGetResourceTelemetryHistory,
      WS_METHODS.serverGetUsageSummary,
      WS_METHODS.serverRefreshUsageRates,
      WS_METHODS.subscribeResourceTelemetry,
    ]) {
      expect(requiredScopeForRpcMethod(method), method).toBe(AuthDiagnosticsReadScope);
    }
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetHostResources)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [
      WS_METHODS.terminalObserve,
      WS_METHODS.subscribeTerminalEvents,
      WS_METHODS.subscribeTerminalMetadata,
    ]) {
      expect(requiredScopeForRpcMethod(method), method).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalRestart,
      WS_METHODS.terminalClose,
    ]) {
      expect(requiredScopeForRpcMethod(method), method).toBe(AuthTerminalOperateScope);
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

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
    {
      scopes: [AuthOrchestrationReadScope, AuthDiagnosticsReadScope],
      missing: AuthEnvironmentMaintainScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            group.toLayerHandler(WS_METHODS.hermesWorkSetupStart, () => Effect.never),
            group.toLayerHandler(WS_METHODS.hermesWorkSubscribeChanges, () => Stream.never),
            rpcScopeAuthorizationLayer(scopes),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: missing });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
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
        // Old clients decode the broad parent; new ones read the exact permission.
        requiredScope: AuthOrchestrationOperateScope,
        requiredPermission: AuthEnvironmentMaintainScope,
      });
      expect(
        yield* client[WS_METHODS.hermesWorkSetupStart]({ providerInstanceId: "hermes" }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthProvidersManageScope,
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

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstances = {
    [ProviderInstanceId.make("codex_work")]: {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {},
    },
  };

  it.effect("allows provider-only patches while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            rpcScopeAuthorizationLayer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: { providerInstances } });
      expect(handled).toBe(1);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access", providerInstances },
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings grant create or remove providers", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            rpcScopeAuthorizationLayer([AuthSettingsWriteScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({
        patch: { defaultRuntimeMode: "full-access" },
      });
      expect(handled).toBe(1);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({ patch: { providerInstances } }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(1);
    }).pipe(Effect.scoped),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          rpcScopeAuthorizationLayer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          rpcScopeAuthorizationLayer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "browser-artifact", fileName: "screenshot.png" },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(2);
  }).pipe(Effect.scoped),
);
