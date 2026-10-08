import { subscribeHermesWorkChanges } from "./hermes/HermesWorkChanges.ts";
import { HermesWorkSetupService } from "./hermes/HermesWorkSetupService.ts";
import { HermesWorkModelAuth } from "./hermes/HermesWorkModelAuth.ts";
import { ProviderAuthService } from "./provider/Services/ProviderAuthService.ts";
import { makeProviderInstallation } from "./provider/providerInstallation.ts";
import { consumeInstanceResetCredit } from "./provider/consumeResetCredit.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import { withCreatedPullRequestLink } from "./git/linkCreatedPullRequest.ts";
import { AgentSessionScanner } from "./project/AgentSessionScanner.ts";
import { AgentSessionImporter } from "./project/AgentSessionImporter.ts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  AuthAccessStreamError,
  authScopeResponse,
  type AuthAccessStreamEvent,
  type ApplicationStoredEvent,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  type ScheduledTaskListResult,
  ProviderSetupError,
  type ProviderInstanceId,
  ClientConnectionMethod,
  ClientDeviceType,
  ClientOs,
  ClientSurface,
  ClientWebDeployment,
  CommandId,
  type DiscoveredLocalServerList,
  type EditorId,
  type FileManagerRevealKind,
  type ServerConfig as ClientServerConfig,
  type ServerConfigStreamEvent,
  type OrchestrationClientOrigin,
  type OrchestrationV2Command,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationSearchThreadsError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GenerateHandoffScriptError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2ThreadLaunchError,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ProjectCreateNewInput,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  type ProjectMutation,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  ProjectMutationError,
  ProjectProvisionError,
  ProviderUploadFeedbackError,
  RelayClientInstallFailedError,
  type RelayClientInstallProgressEvent,
  type ServerSelfUpdateError,
  type ServerSelfUpdateProgressEvent,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  RpcClientId,
  ThreadId,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { windowOrchestrationV2ThreadProjection } from "@t3tools/shared/orchestrationV2Window";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as ThreadFeedbackService from "./orchestration-v2/ThreadFeedbackService.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import { HermesDashboardClient } from "./hermes/HermesDashboardClient.ts";
import { HermesWorkService } from "./hermes/HermesWorkService.ts";
import { HermesWorkGroupsService } from "./hermes/HermesWorkGroupsService.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import {
  archivedShellStreamItemFromThreadShell,
  buildActiveShellSnapshot,
  coalesceShellApplicationEvents,
  coalesceStoredThreadEvents,
  composeShellStreamWithEnrichment,
  dedupeShellEnrichment,
  shellStreamItemFromEnrichmentRefresh,
  shellStreamItemFromThreadShell,
  shellStreamItemsFromInitialSnapshot,
  shellStreamItemsFromResumeSnapshot,
  skipUnchangedThreadShells,
} from "./orchestration-v2/ShellStream.ts";
import { ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION } from "./orchestration-v2/ProjectionStore.ts";
import { readThreadResumeReplay } from "./orchestration-v2/ThreadStream.ts";
import {
  projectDomainEventForWire,
  projectThreadProjectionForWire,
} from "./orchestration-v2/WireProjection.ts";
import {
  coalesceThreadStreamFrames,
  streamThreadLiveFrames,
} from "./orchestration-v2/ThreadStreamFrames.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadSearchQuery from "./orchestration-v2/ThreadSearchQuery.ts";
import { readWorkflowScript } from "./orchestration-v2/WorkflowScriptQuery.ts";
import * as OrchestrationEventStore from "./persistence/Services/OrchestrationEventStore.ts";
import { userFacingDispatchErrorMessage } from "./orchestration-v2/UserFacingErrors.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ProviderInstanceRegistry from "./provider/Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as ProviderMaintenance from "./provider/providerMaintenance.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { withTerminalOutputWindow } from "./terminal/OutputProtocol.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "./preview/Manager.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
import { persistChatAttachments } from "./assets/ChatAttachmentPersistence.ts";
import * as AttachmentClaims from "./orchestration-v2/AttachmentClaims.ts";
import { deletePendingAttachment, issueAttachmentUploadUrl } from "./assets/AttachmentUpload.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as NewProject from "./project/NewProject.ts";
import * as ScratchProject from "./project/ScratchProject.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import {
  makeThreadHandoffScript,
  makeThreadHandoffTranscript,
} from "./orchestration-v2/ThreadHandoffScript.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as DefectReporter from "./observability/DefectReporter.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { rpcScopeAuthorizationLayer } from "./auth/RpcAuthorization.ts";
import { RpcInstrumentation, rpcInstrumentationLayer } from "./observability/RpcInstrumentation.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubRepositoryApi from "./sourceControl/GitHubRepositoryApi.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./auth/http.ts";
import * as RelayClient from "@t3tools/shared/relayClient";

const CONFIG_DISCOVERY_TIMEOUT = Duration.seconds(5);

const HANDOFF_SCRIPT_SUMMARY_TIMEOUT_MS = 120_000;

const resolveDiscoveryForConfig = <A, E, R>(
  discovery: Effect.Effect<A, E, R>,
  onTimeout: () => A,
) =>
  discovery.pipe(
    Effect.timeoutOption(CONFIG_DISCOVERY_TIMEOUT),
    Effect.map(Option.getOrElse(onTimeout)),
  );

export const resolveAvailableEditorsForConfig = <A, E, R>(
  discovery: Effect.Effect<ReadonlyArray<A>, E, R>,
) => resolveDiscoveryForConfig(discovery, () => []);

export const resolveFileManagerRevealKindForConfig = <E, R>(
  discovery: Effect.Effect<FileManagerRevealKind | undefined, E, R>,
) => resolveDiscoveryForConfig(discovery, () => undefined);

/**
 * Runs first in `server.refreshProviders`. An explicit catalog refresh
 * (`refreshModels`) bypasses T3-owned caches: the remote model manifest, each
 * targeted instance's discovery caches and maintenance resolution, and the
 * npm latest-version cache. A fresh workspace refresh invalidates only the
 * targeted instance's discovery caches, inside
 * `ProviderRegistry.refreshWorkspaceSnapshot`. Other workspace discovery and
 * background status checks keep their timers.
 */
export const bypassOwnedProviderCachesForRefresh = Effect.fn(
  "ws.bypassOwnedProviderCachesForRefresh",
)(function* (input: {
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly refreshModels?: boolean | undefined;
}) {
  if (!input.refreshModels) return;
  const modelManifest = yield* ModelManifest.ModelManifest;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerVersionCache = yield* ProviderMaintenance.ProviderVersionCache;
  yield* modelManifest.forceRefresh;
  const instances = yield* providerInstances.listInstances;
  yield* Effect.forEach(
    instances.filter(
      (instance) => input.instanceId === undefined || input.instanceId === instance.instanceId,
    ),
    (instance) =>
      Effect.gen(function* () {
        yield* instance.invalidateCaches ?? Effect.void;
        const maintenance = instance.snapshot.resolveMaintenance
          ? yield* instance.snapshot.resolveMaintenance({ fresh: true })
          : instance.snapshot.maintenanceCapabilities;
        if (maintenance.packageName) providerVersionCache.delete(maintenance.packageName);
      }),
    { concurrency: "unbounded", discard: true },
  );
});

type EditorDiscovery = Pick<
  ExternalLauncher.ExternalLauncher["Service"],
  "resolveAvailableEditors" | "resolveFileManagerRevealKind"
>;

// The config fields that follow from which editors are installed.
const resolveEditorConfig = <E, R>(
  availableEditors: ReadonlyArray<EditorId>,
  revealKind: Effect.Effect<FileManagerRevealKind | undefined, E, R>,
) =>
  Effect.gen(function* () {
    const fileManagerRevealKind = availableEditors.includes("file-manager")
      ? yield* revealKind
      : undefined;
    return {
      availableEditors,
      ...(fileManagerRevealKind === undefined
        ? {}
        : {
            shellRevealInFileManager: true,
            shellRevealInFileManagerKind: fileManagerRevealKind,
          }),
    };
  });

/**
 * Live config updates that follow a snapshot of `config`. A busy host can
 * outlast the snapshot's discovery timeouts, which send no editors, or no
 * reveal kind for the file manager. The scan keeps running, so once it lands
 * this resends the config: clients replace theirs on any snapshot. The resent
 * config is folded from the live updates already sent, so it cannot roll back
 * a change that landed while the scan ran.
 */
export const withLateEditorConfig = <E, R>(
  config: ClientServerConfig,
  liveUpdates: Stream.Stream<ServerConfigStreamEvent, E, R>,
  launcher: EditorDiscovery,
) => {
  const lateEditorConfig = Stream.fromEffect(launcher.resolveAvailableEditors()).pipe(
    Stream.filter(
      (editors) =>
        editors.join() !== config.availableEditors.join() ||
        (editors.includes("file-manager") && config.shellRevealInFileManagerKind === undefined),
    ),
    // Unbounded, unlike the snapshot: the reveal-kind probe is not shared, so
    // a timeout here would cancel a probe that outlasts it every time.
    Stream.mapEffect((editors) =>
      resolveEditorConfig(editors, launcher.resolveFileManagerRevealKind()),
    ),
    Stream.filter(
      (editorConfig) =>
        editorConfig.availableEditors.join() !== config.availableEditors.join() ||
        editorConfig.shellRevealInFileManagerKind !== config.shellRevealInFileManagerKind,
    ),
    Stream.map((editorConfig) => ({ type: "editorsResolved" as const, editorConfig })),
  );

  return Stream.merge(liveUpdates, lateEditorConfig).pipe(
    Stream.mapAccum(
      (): ClientServerConfig => config,
      (current, event): readonly [ClientServerConfig, ReadonlyArray<ServerConfigStreamEvent>] => {
        switch (event.type) {
          case "editorsResolved": {
            const {
              availableEditors: _editors,
              shellRevealInFileManager: _reveal,
              shellRevealInFileManagerKind: _revealKind,
              ...rest
            } = current;
            const next = { ...rest, ...event.editorConfig };
            return [next, [{ version: 1, type: "snapshot", config: next }]];
          }
          case "keybindingsUpdated":
            return [{ ...current, ...event.payload }, [event]];
          case "providerStatuses":
            return [{ ...current, providers: event.payload.providers }, [event]];
          case "settingsUpdated":
            return [{ ...current, settings: event.payload.settings }, [event]];
          // Themes and usage-limit sources never ride in a snapshot; clients
          // carry their projected values across one.
          default:
            return [current, [event]];
        }
      },
    ),
  );
};

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceEntriesReadDirectoryError":
      return {
        failure: "directory_list_failed",
        ...(error.cwd !== undefined ? { normalizedCwd: error.cwd } : {}),
        detail: error.message,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function filesystemBrowseFailureContext(error: WorkspaceEntries.WorkspaceEntriesBrowseError): {
  readonly failure: FilesystemBrowseFailure;
  readonly parentPath?: string;
  readonly platform?: string;
} {
  switch (error._tag) {
    case "WorkspaceEntriesWindowsPathUnsupportedError":
      return { failure: "windows_path_unsupported", platform: error.platform };
    case "WorkspaceEntriesCurrentProjectRequiredError":
      return { failure: "current_project_required" };
    case "WorkspaceEntriesReadDirectoryError":
      return { failure: "read_directory_failed", parentPath: error.parentPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceFileSystemOperationError":
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      };
    case "WorkspaceFilePathEscapeError":
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    case "WorkspacePathNotFileError":
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    case "WorkspaceBinaryFileError":
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

// Middleware added later wraps middleware added earlier, so instrumentation wraps authorization.
const ServerWsRpcGroup = WsRpcGroup.middleware(RpcInstrumentation);
// When a resuming client's cursor is more than this many events behind the
// current head, skip the per-event catch-up replay and send a fresh shell
// snapshot instead. Replaying each intervening event costs a shell refetch;
// past this gap a single O(active-threads) snapshot is cheaper and bounded.
// Matches the event store's default page size (DEFAULT_READ_FROM_SEQUENCE_LIMIT).
const SHELL_RESUME_MAX_GAP = 1_000;

function toAuthAccessStreamEvent(
  change: PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: { ...change.pairingLink, ...authScopeResponse(change.pairingLink.scopes) },
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          ...authScopeResponse(change.clientSession.scopes),
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const isClientSurface = Schema.is(ClientSurface);
const isClientConnectionMethod = Schema.is(ClientConnectionMethod);
const isClientDeviceType = Schema.is(ClientDeviceType);
const isClientOs = Schema.is(ClientOs);
const isClientWebDeployment = Schema.is(ClientWebDeployment);
const MAX_CLIENT_APP_VERSION_LENGTH = 64;
const MAX_CLIENT_BROWSER_LENGTH = 64;
const MAX_CLIENT_DEVICE_MODEL_LENGTH = 80;

/**
 * Only turns away a client that names a version this server cannot speak. A
 * client that names none predates negotiation and already speaks this wire --
 * unlike upstream, whose version 1 was a genuinely different protocol -- so
 * rejecting it would lock every shipped build out of an updated server.
 */
export function hasCompatibleOrchestrationProtocol(url: URL): boolean {
  const declared = url.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM);
  return declared === null || declared === String(ORCHESTRATION_PROTOCOL_VERSION);
}

// Optional client identity announced on the /ws upgrade URL next to wsTicket.
// Lenient by design: absent or malformed values degrade to {} so a connection
// never fails over attribution metadata.
function readClientConnectionOrigin(
  request: HttpServerRequest.HttpServerRequest,
): OrchestrationClientOrigin {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return {};
  }
  const surface = url.value.searchParams.get("clientSurface");
  const appVersion = url.value.searchParams.get("clientAppVersion")?.trim() ?? "";
  return {
    ...(isClientSurface(surface) ? { surface } : {}),
    ...(appVersion !== "" && appVersion.length <= MAX_CLIENT_APP_VERSION_LENGTH
      ? { appVersion }
      : {}),
  };
}

// Client telemetry stays in this socket's RPC layer. It must not become a
// server-global "current client" because several client types can connect at once.
function readClientAnalyticsProps(request: HttpServerRequest.HttpServerRequest) {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return {};
  }

  const surface = url.value.searchParams.get("clientSurface");
  const appVersion = url.value.searchParams.get("clientAppVersion")?.trim() ?? "";
  const deviceType = url.value.searchParams.get("clientDeviceType");
  const os = url.value.searchParams.get("clientOs");
  const webDeployment = url.value.searchParams.get("clientWebDeployment");
  const browser = url.value.searchParams.get("clientBrowser")?.trim() ?? "";
  const connectionMethod = url.value.searchParams.get("connectionMethod");
  const rawOsMajorVersion = url.value.searchParams.get("clientOsMajorVersion") ?? "";
  const osMajorVersion = Number(rawOsMajorVersion);
  const deviceModel = url.value.searchParams.get("clientDeviceModel")?.trim() ?? "";
  const isMobile = surface === "mobile";
  const hasOsMajorVersion =
    isMobile && rawOsMajorVersion !== "" && Number.isInteger(osMajorVersion) && osMajorVersion > 0;
  const hasDeviceModel =
    isMobile && deviceModel !== "" && deviceModel.length <= MAX_CLIENT_DEVICE_MODEL_LENGTH;

  return {
    ...(isClientSurface(surface) ? { surface } : {}),
    ...(appVersion !== "" && appVersion.length <= MAX_CLIENT_APP_VERSION_LENGTH
      ? { appVersion, clientAppVersion: appVersion }
      : {}),
    ...(isClientOs(os)
      ? {
          clientOs: os,
          ...(isMobile && (os === "iOS" || os === "Android") ? { os } : {}),
        }
      : {}),
    ...(isClientDeviceType(deviceType) ? { clientDeviceType: deviceType } : {}),
    ...(surface === "web" && isClientWebDeployment(webDeployment) ? { webDeployment } : {}),
    ...(surface === "web" && browser !== "" && browser.length <= MAX_CLIENT_BROWSER_LENGTH
      ? { clientBrowser: browser }
      : {}),
    ...(hasOsMajorVersion ? { osMajorVersion, clientOsMajorVersion: osMajorVersion } : {}),
    ...(hasDeviceModel ? { deviceModel, clientDeviceModel: deviceModel } : {}),
    ...(isClientConnectionMethod(connectionMethod) ? { connectionMethod } : {}),
  };
}

const makeWsRpcLayer = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  clientOrigin: OrchestrationClientOrigin,
  clientAnalyticsProps: Readonly<Record<string, unknown>>,
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
) =>
  ServerWsRpcGroup.toLayer(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      const providerAuth = yield* ProviderAuthService;
      const providerInstallation = yield* makeProviderInstallation();
      const sql = yield* SqlClient.SqlClient;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const mcpAppRequests = yield* McpAppRequests.McpAppRequests;
      const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const threadSearchQuery = yield* ThreadSearchQuery.ThreadSearchQuery;
      const analytics = yield* AnalyticsService.AnalyticsService;
      const threadFeedback = yield* ThreadFeedbackService.ThreadFeedbackServiceV2;
      // Attribution for work this connection started. V2 domain events carry no
      // metadata bag to stamp, and the thread already records its own
      // creationSource provenance, so client identity rides the analytics
      // events here and the auth session row rather than every persisted event.
      const recordClientCommandAnalytics = (command: OrchestrationV2Command) => {
        switch (command.type) {
          case "thread.create":
            return analytics.record("client.thread.started", clientAnalyticsProps);
          case "message.dispatch":
            return analytics.record("client.turn.requested", clientAnalyticsProps);
          default:
            return Effect.void;
        }
      };
      const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
      const enrichProjectShells = Effect.fn("ws.orchestrationV2.enrichProjectShells")(
        (projects: ReadonlyArray<OrchestrationProjectShell>) =>
          Effect.forEach(
            projects,
            (project) =>
              // Non-blocking: emit with cached identity (or null) and schedule
              // background resolution. subscribeChanges is attached before
              // loadSnapshot, so later identity completions push refreshed
              // shells for multi-env grouping without blocking the initial
              // snapshot or completion marker on slow git probes.
              projectEnrichment.getAvailable(project.workspaceRoot).pipe(
                Effect.map((enrichment) => ({
                  project: {
                    ...project,
                    repositoryIdentity: enrichment.repositoryIdentity,
                  },
                  repositoryIdentityResolved: enrichment.repositoryIdentityResolved,
                })),
              ),
            { concurrency: 16 },
          ).pipe(
            Effect.map((enriched) => ({
              projects: enriched.map((entry) => entry.project),
              resolvedRepositoryIdentityRoots: enriched
                .filter((entry) => entry.repositoryIdentityResolved)
                .map((entry) => entry.project.workspaceRoot),
            })),
          ),
      );
      const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
      const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
      // A webhook URL starts agent runs, so only sessions that may operate
      // see it; read-only sessions still see the task itself.
      const withVisibleWebhookUrls = (result: ScheduledTaskListResult): ScheduledTaskListResult =>
        currentSession.scopes.includes(AuthOrchestrationOperateScope)
          ? result
          : {
              tasks: result.tasks.map(({ webhook: _webhook, ...task }) => task),
            };
      const hermesSetup = yield* HermesWorkSetupService;
      const hermesModelAuth = yield* HermesWorkModelAuth;
      const hermesDashboard = yield* HermesDashboardClient;
      const hermesWork = yield* HermesWorkService;
      const hermesWorkGroups = yield* HermesWorkGroupsService;
      const agentSessionScanner = yield* AgentSessionScanner;
      const agentSessionImporter = yield* AgentSessionImporter;
      const projectService = yield* ProjectService.ProjectService;
      const textGeneration = yield* TextGeneration.TextGeneration;
      const secretRequests = yield* SecretRequests.SecretRequests;
      const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const keybindings = yield* Keybindings.Keybindings;
      const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const remoteOpenTargets = yield* RemoteOpenTargets.RemoteOpenTargets;
      const directEndpoints = yield* DirectEndpoints.DirectEndpoints;
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
      const review = yield* ReviewService.ReviewService;
      const vcsProvisioning = yield* VcsProvisioningService.VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager.TerminalManager;
      const previewManager = yield* PreviewManager.PreviewManager;
      const portDiscovery = yield* PortScanner.PortDiscovery;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
      const rpcClientIds = yield* Ref.make(new Set<RpcClientId>());
      yield* Effect.addFinalizer(() =>
        Ref.get(rpcClientIds).pipe(
          Effect.flatMap((clientIds) =>
            Effect.forEach(
              clientIds,
              (clientId) => backgroundPolicy.removeRpcClient(currentSessionId, clientId),
              {
                discard: true,
              },
            ),
          ),
          Effect.ignore,
        ),
      );
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sourceControlDiscovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const automaticGitFetchInterval = serverSettings.getSettings.pipe(
        Effect.map(
          (settings) => resolveServerBackgroundActivitySettings(settings).automaticGitFetchInterval,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read automatic Git fetch interval setting", {
            detail: cause.message,
          }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
        ),
      );
      const sourceControlRepositories =
        yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const repositoryIdentityResolver =
        yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const pullRequests = yield* PullRequestService.PullRequestService;
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const sessions = yield* SessionStore.SessionStore;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
      const hostResources = yield* HostResources.HostResources;
      const resourceTelemetry = yield* ResourceTelemetry.ResourceTelemetry;
      const usage = yield* UsageService.UsageService;
      const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
      const relayClient = yield* RelayClient.RelayClient;
      // RpcScopeAuthorization (WsRpcGroup middleware) checks each RPC's declared
      // scope before its handler runs.
      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks(),
          clientSessions: serverAuth.listClientSessions(currentSessionId),
        }).pipe(
          Effect.mapError(
            (error) =>
              new AuthAccessStreamError({
                message: error.message,
              }),
          ),
        );

      const fileSystem = yield* FileSystem.FileSystem;
      const scratchProject = yield* ScratchProject.make(config.baseDir);
      // Projects started from just a name live beside Scratch and worktrees,
      // away from folders the user organizes by hand. A nested repository is
      // fine here (unlike Scratch) because each project gets its own `git init`.
      const newProjectsRoot = path.resolve(config.baseDir, "projects");
      const gitVcsDriver = yield* GitVcsDriver.GitVcsDriver;
      const createNewProject = (input: ProjectCreateNewInput) =>
        NewProject.createNewProject({ root: newProjectsRoot, name: input.name }).pipe(
          Effect.provideService(GitVcsDriver.GitVcsDriver, gitVcsDriver),
          Effect.provideService(ProjectService.ProjectService, projectService),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = ServerSettings.redactServerSettingsForClient(
          yield* serverSettings.getSettings,
        );
        const environment = yield* serverEnvironment.getDescriptor;
        const auth = yield* serverAuth.getDescriptor();
        const scratchWorkspaceRoot = yield* scratchProject.workspaceRoot;
        const editorConfig = yield* resolveEditorConfig(
          yield* resolveAvailableEditorsForConfig(externalLauncher.resolveAvailableEditors()),
          resolveFileManagerRevealKindForConfig(externalLauncher.resolveFileManagerRevealKind()),
        );

        return {
          environment,
          auth,
          cwd: config.cwd,
          t3WorkDirectory: config.t3WorkDir ?? path.join(config.baseDir, "t3-work"),
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          ...editorConfig,
          // Same discovery-with-timeout treatment as editors: a slow probe
          // must not stall server.getConfig, so it degrades to no targets.
          remoteOpenTargets: yield* resolveAvailableEditorsForConfig(
            remoteOpenTargets.resolveTargets(),
          ),
          directEndpoints: yield* resolveAvailableEditorsForConfig(directEndpoints.resolve()),
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? { otlpMetricsUrl: config.otlpMetricsUrl }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          },
          settings,
          shellResumeCompletionMarker: true,
          threadResumeCompletionMarker: true,
          threadSnapshotWindow: true,
          ...(scratchWorkspaceRoot === undefined ? {} : { scratchWorkspaceRoot }),
          newProjectsRoot,
        };
      });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      const subscribeOrchestrationV2Thread = Effect.fn("ws.orchestrationV2.subscribeThread")(
        function* (input: {
          readonly threadId: ThreadId;
          readonly afterSequence?: number;
          readonly requestCompletionMarker?: boolean;
          readonly snapshotMaxVisibleItems?: number;
        }) {
          yield* Effect.annotateCurrentSpan({
            "orchestration_v2.thread_id": input.threadId,
          });
          yield* threadManagement.ensureLegacyTranscript(input.threadId).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetThreadProjectionError({
                  threadId: input.threadId,
                  message: `Failed to hydrate migrated thread ${input.threadId}`,
                  cause,
                }),
            ),
          );

          const loadSnapshotItem = Effect.fn("ws.orchestrationV2.loadThreadSnapshotItem")(
            function* () {
              const snapshot = yield* threadManagement.getThreadSnapshot(input.threadId).pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationV2GetThreadProjectionError({
                      threadId: input.threadId,
                      message: `Failed to load orchestration V2 thread ${input.threadId}`,
                      cause,
                    }),
                ),
              );
              const windowed =
                input.snapshotMaxVisibleItems === undefined
                  ? snapshot.projection
                  : windowOrchestrationV2ThreadProjection(
                      snapshot.projection,
                      input.snapshotMaxVisibleItems,
                    );
              return {
                kind: "snapshot" as const,
                snapshotSequence: snapshot.snapshotSequence,
                projection: projectThreadProjectionForWire(windowed),
              };
            },
          );

          // Paced by the client's acks: superseded updates are dropped, and a
          // backlog over the resume budget is replaced by one snapshot.
          const eventStreamFrom = (afterSequence: number) =>
            streamThreadLiveFrames({
              events: threadManagement
                .streamStoredEventsFrom({
                  threadId: input.threadId,
                  afterSequence,
                })
                .pipe(
                  Stream.map((stored) => ({
                    kind: "event" as const,
                    sequence: stored.sequence,
                    event: projectDomainEventForWire(stored.event),
                  })),
                  Stream.mapError(
                    (cause) =>
                      new OrchestrationV2GetThreadProjectionError({
                        threadId: input.threadId,
                        message: `Failed while streaming orchestration V2 thread ${input.threadId}`,
                        cause,
                      }),
                  ),
                ),
              loadSnapshot: loadSnapshotItem(),
            });

          const loadReplayThrough = (
            afterSequence: number,
            throughSequence: number,
            limit: number,
          ) =>
            applicationEvents
              .readAgentEvents({
                threadId: input.threadId,
                afterSequence,
                throughSequence,
                limit,
              })
              .pipe(
                Stream.map((stored) => ({
                  kind: "event" as const,
                  sequence: stored.sequence,
                  event: projectDomainEventForWire(stored.event),
                })),
                Stream.runCollect,
                Effect.map((items) => Array.from(items)),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationV2GetThreadProjectionError({
                      threadId: input.threadId,
                      message: `Failed while replaying orchestration V2 thread ${input.threadId}`,
                      cause,
                    }),
                ),
              );

          const completionMarker =
            input.requestCompletionMarker === true
              ? Stream.make({ kind: "synchronized" as const })
              : Stream.empty;

          const snapshotThenLive = Effect.fn("ws.orchestrationV2.threadSnapshotThenLive")(
            function* () {
              const snapshot = yield* loadSnapshotItem();
              return Stream.concat(
                Stream.concat(Stream.make(snapshot), completionMarker),
                eventStreamFrom(snapshot.snapshotSequence),
              );
            },
          );

          // When the client already holds the projection (cached, or loaded over
          // HTTP) it passes that snapshot's sequence, and we resume by replaying
          // persisted events after it instead of re-sending the (potentially
          // multi-KB) snapshot frame over the socket. The event sink subscribes
          // to live events before reading the persisted tail, so no event
          // published during the replay window is lost; overlapping events are
          // deduped by sequence on the client.
          if (input.afterSequence !== undefined) {
            const highWater = yield* applicationEvents.latestAgentSequence(input.threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationV2GetThreadProjectionError({
                    threadId: input.threadId,
                    message: `Failed to prepare orchestration V2 thread ${input.threadId} replay`,
                    cause,
                  }),
              ),
            );
            // The read stops one event past the replay budget on the thread's
            // own stream index, so a cursor far behind on a busy server costs
            // the same as a near one when this thread was idle.
            const replay = yield* readThreadResumeReplay({
              afterSequence: input.afterSequence,
              highWater,
              readReplay: loadReplayThrough,
            });
            if (replay !== null) {
              return Stream.concat(
                Stream.concat(
                  coalesceThreadStreamFrames(Stream.fromIterable(replay)),
                  completionMarker,
                ),
                eventStreamFrom(highWater),
              );
            }
            // Cursor ahead of the store, too many events, or too many bytes:
            // fall through to the snapshot path below.
          }

          return yield* snapshotThenLive();
        },
      );

      const subscribeOrchestrationV2Shell = Effect.fn("ws.orchestrationV2.subscribeShell")(
        function* (input: {
          readonly afterSequence?: number;
          readonly requestCompletionMarker?: boolean;
        }) {
          const enrichmentChanges = yield* projectEnrichment.subscribeChanges;
          const loadSnapshot = Effect.fn("ws.orchestrationV2.loadShellSnapshot")(function* () {
            const base = yield* sql.withTransaction(
              Effect.gen(function* () {
                const projects = yield* projectionSnapshotQuery.getProjectShellsWithoutEnrichment();
                const threads = yield* threadManagement.getShellSnapshot({ location: "active" });
                return buildActiveShellSnapshot({
                  projects,
                  threads,
                  snapshotSequence: yield* applicationEvents.latestApplicationSequence,
                });
              }),
            );
            const enriched = yield* enrichProjectShells(base.projects);
            return {
              snapshot: { ...base, projects: enriched.projects } as OrchestrationV2ShellSnapshot,
              resolvedRepositoryIdentityRoots: enriched.resolvedRepositoryIdentityRoots,
            };
          });
          const projectItem = Effect.fn("ws.orchestrationV2.projectShellItem")(function* (
            stored: Extract<ApplicationStoredEvent, { readonly aggregateKind: "project" }>,
          ) {
            if (stored.type === "project.deleted") {
              return {
                kind: "project.removed" as const,
                sequence: stored.sequence,
                projectId: stored.payload.projectId,
              };
            }
            const project = yield* projectionSnapshotQuery.getProjectShellById(
              stored.payload.projectId,
            );
            return Option.match(project, {
              onNone: () => ({
                kind: "project.removed" as const,
                sequence: stored.sequence,
                projectId: stored.payload.projectId,
              }),
              onSome: (value) => ({
                kind: "project.updated" as const,
                sequence: stored.sequence,
                project: value,
              }),
            });
          });

          // Coalescing makes each per-thread shell read represent every event
          // for that thread in the current window; reading only the affected
          // threads keeps the cost of a busy stream independent of how many
          // threads exist overall.
          const projectShellItems = Effect.fn("ws.orchestrationV2.projectShellItems")(function* (
            events: ReadonlyArray<ApplicationStoredEvent>,
          ) {
            return yield* Effect.forEach(
              coalesceShellApplicationEvents(events),
              (stored) =>
                Effect.gen(function* () {
                  if ("aggregateKind" in stored) {
                    return yield* projectItem(stored);
                  }
                  const shell = yield* threadManagement.getThreadShell(stored.event.threadId);
                  return shellStreamItemFromThreadShell({ stored, shell });
                }),
              { concurrency: 8 },
            );
          });

          const toShellStream = <E, R>(stream: Stream.Stream<ApplicationStoredEvent, E, R>) =>
            stream.pipe(
              Stream.groupedWithin(512, Duration.millis(50)),
              Stream.mapEffect((events) => projectShellItems(Array.from(events))),
              Stream.flatMap(Stream.fromIterable),
              skipUnchangedThreadShells,
            );

          const liveFrom = (afterSequence: number) =>
            toShellStream(applicationEvents.streamApplicationEvents({ afterSequence }));

          const enrichmentRefreshes = Stream.fromSubscription(enrichmentChanges).pipe(
            Stream.filter((change) => change.repositoryIdentityResolved),
            Stream.groupedWithin(64, Duration.millis(25)),
            // Build the refresh from the identities the changes carry. A full
            // snapshot load here read every thread shell and re-enriched every
            // project, for every subscriber, on every change.
            Stream.mapEffect((changes) =>
              Effect.gen(function* () {
                const identities = new Map(
                  Array.from(changes, (change) => [
                    change.workspaceRoot,
                    change.enrichment.repositoryIdentity,
                  ]),
                );
                const snapshotSequence = yield* applicationEvents.latestApplicationSequence;
                const projects =
                  (yield* projectionSnapshotQuery.getProjectShellsWithoutEnrichment()).flatMap(
                    (project) =>
                      identities.has(project.workspaceRoot)
                        ? [
                            {
                              ...project,
                              repositoryIdentity: identities.get(project.workspaceRoot) ?? null,
                            },
                          ]
                        : [],
                  );
                return shellStreamItemFromEnrichmentRefresh({
                  snapshot: {
                    schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
                    snapshotSequence,
                    projects,
                    threads: [],
                    archivedThreads: [],
                  },
                  changes: Array.from(changes),
                });
              }),
            ),
          );

          // Always attach the enrichment subscription before the first load so
          // completions that race HTTP snapshot fetch still push a refresh.
          // When the client already holds a shell snapshot (cached, or loaded
          // over HTTP) it passes that snapshot's sequence. We still emit one
          // enriched snapshot up front: getAvailable may have been cold on the
          // HTTP path (null identity), and enrichment PubSub events published
          // before this subscribe attached are dropped. Rehydrating here fills
          // repositoryIdentity for cross-environment project grouping even on
          // afterSequence resumes. Application events after the sequence still
          // stream as deltas; overlapping events are deduped by sequence on the
          // client.
          //
          // After the unmarked authoritative frame, emit a same-sequence
          // metadata-only frame for roots that already resolved successfully
          // (including cached null). Cold/failed roots stay unmarked and use
          // the PubSub enrichment path when they complete later.
          const completionMarker =
            input.requestCompletionMarker === true
              ? Stream.make({ kind: "synchronized" as const })
              : Stream.empty;
          const initialSnapshotItems = (loaded: {
            readonly snapshot: OrchestrationV2ShellSnapshot;
            readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
          }) =>
            Stream.fromIterable(
              shellStreamItemsFromInitialSnapshot({
                snapshot: loaded.snapshot,
                resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
              }),
            );
          // A resuming client already holds the shell body, so its prefix is the
          // metadata-only enrichment frame — never a second full projects and
          // threads snapshot.
          const initialEnrichmentItems = (loaded: {
            readonly snapshot: OrchestrationV2ShellSnapshot;
            readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
          }) =>
            Stream.fromIterable(
              shellStreamItemsFromResumeSnapshot({
                snapshot: loaded.snapshot,
                resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
              }),
            );
          // Initial unmarked (+ optional same-load marked) always drains first.
          // Enrichment merges only with the post-prefix tail so a ready marked
          // refresh cannot interleave before the authoritative initial frame.
          const completionThenLive = (afterSequence: number) =>
            Stream.concat(completionMarker, liveFrom(afterSequence));

          const stream = yield* Effect.gen(function* () {
            const loaded = yield* loadSnapshot();
            const initial = initialSnapshotItems(loaded);
            if (input.afterSequence === undefined) {
              return composeShellStreamWithEnrichment({
                initial,
                tail: completionThenLive(loaded.snapshot.snapshotSequence),
                enrichment: enrichmentRefreshes,
              });
            }

            const highWater = yield* applicationEvents.latestApplicationSequence;
            const replayGap = highWater - input.afterSequence;
            if (replayGap < 0 || replayGap > SHELL_RESUME_MAX_GAP) {
              return composeShellStreamWithEnrichment({
                initial,
                tail: completionThenLive(loaded.snapshot.snapshotSequence),
                enrichment: enrichmentRefreshes,
              });
            }

            const replay = toShellStream(
              applicationEvents.readApplicationEvents({
                afterSequence: input.afterSequence,
                throughSequence: highWater,
              }),
            );
            return composeShellStreamWithEnrichment({
              initial: initialEnrichmentItems(loaded),
              tail: Stream.concat(Stream.concat(replay, completionMarker), liveFrom(highWater)),
              enrichment: enrichmentRefreshes,
            });
          }).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetShellSnapshotError({
                  message: "Failed to prepare the application shell stream",
                  cause,
                }),
            ),
          );

          return stream.pipe(
            dedupeShellEnrichment,
            Stream.mapError(
              (cause) =>
                new OrchestrationV2GetShellSnapshotError({
                  message: "Failed while streaming the application shell",
                  cause,
                }),
            ),
          );
        },
      );

      const getOrchestrationV2ArchivedShellSnapshot = sql
        .withTransaction(
          Effect.gen(function* () {
            const projects = yield* projectionSnapshotQuery.getProjectShellsWithoutEnrichment();
            const threads = yield* threadManagement.getShellSnapshot({ location: "archive" });
            return {
              schemaVersion: threads.schemaVersion,
              snapshotSequence: yield* applicationEvents.latestApplicationSequence,
              projects,
              threads: threads.archivedThreads,
            } as const;
          }),
        )
        .pipe(
          Effect.flatMap((snapshot) =>
            enrichProjectShells(snapshot.projects).pipe(
              Effect.map(({ projects }) => ({ ...snapshot, projects })),
            ),
          ),
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetShellSnapshotError({
                message: "Failed to load archived thread snapshot",
                cause,
              }),
          ),
        );

      const subscribeOrchestrationV2ArchivedShell = Effect.fn(
        "ws.orchestrationV2.subscribeArchivedShell",
      )(function* () {
        const snapshot = yield* getOrchestrationV2ArchivedShellSnapshot;
        const live = threadManagement
          .streamStoredEventsFrom({ afterSequence: snapshot.snapshotSequence })
          .pipe(
            Stream.groupedWithin(512, Duration.millis(50)),
            Stream.mapEffect((events) =>
              Effect.forEach(
                coalesceStoredThreadEvents(Array.from(events)),
                (stored) =>
                  threadManagement
                    .getThreadShell(stored.event.threadId)
                    .pipe(
                      Effect.map((shell) =>
                        archivedShellStreamItemFromThreadShell({ stored, shell }),
                      ),
                    ),
                { concurrency: 8 },
              ),
            ),
            Stream.flatMap(Stream.fromIterable),
            Stream.filterMap((item) => (item === null ? Result.failVoid : Result.succeed(item))),
            Stream.mapError(
              (cause) =>
                new OrchestrationV2GetShellSnapshotError({
                  message: "Failed while streaming archived threads",
                  cause,
                }),
            ),
          );
        return Stream.concat(Stream.make({ kind: "snapshot" as const, snapshot }), live);
      });

      const mutateProject = Effect.fn("ws.projects.mutate")(function* (mutation: ProjectMutation) {
        switch (mutation.type) {
          case "project.create":
            return yield* projectService.create({
              commandId: mutation.commandId,
              projectId: mutation.projectId,
              title: mutation.title,
              workspaceRoot: mutation.workspaceRoot,
              ...(mutation.createWorkspaceRootIfMissing === undefined
                ? {}
                : { createWorkspaceRootIfMissing: mutation.createWorkspaceRootIfMissing }),
              ...(mutation.defaultModelSelection === undefined
                ? {}
                : { defaultModelSelection: mutation.defaultModelSelection }),
              ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
            });
          case "project.update":
            return yield* projectService.update({
              commandId: mutation.commandId,
              projectId: mutation.projectId,
              ...(mutation.title === undefined ? {} : { title: mutation.title }),
              ...(mutation.workspaceRoot === undefined
                ? {}
                : { workspaceRoot: mutation.workspaceRoot }),
              ...(mutation.defaultModelSelection === undefined
                ? {}
                : { defaultModelSelection: mutation.defaultModelSelection }),
              ...(mutation.defaultThreadEnvMode === undefined
                ? {}
                : { defaultThreadEnvMode: mutation.defaultThreadEnvMode }),
              ...(mutation.faviconPath === undefined ? {} : { faviconPath: mutation.faviconPath }),
              ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
            });
          case "project.delete": {
            const snapshot = yield* threadManagement.getShellSnapshot();
            const projectThreads = [...snapshot.threads, ...snapshot.archivedThreads].filter(
              (thread) => thread.projectId === mutation.projectId,
            );
            if (projectThreads.length > 0 && mutation.force !== true) {
              return yield* new ProjectMutationError({
                commandId: mutation.commandId,
                message: `Project ${mutation.projectId} is not empty.`,
              });
            }
            yield* Effect.forEach(
              projectThreads,
              (thread) =>
                threadManagement.dispatch({
                  type: "thread.delete",
                  commandId: CommandId.make(`${mutation.commandId}:delete-thread:${thread.id}`),
                  threadId: thread.id,
                }),
              { concurrency: 1, discard: true },
            );
            return yield* projectService.delete({
              commandId: mutation.commandId,
              projectId: mutation.projectId,
            });
          }
        }
      });

      const handlers = ServerWsRpcGroup.of({
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
          Effect.annotateCurrentSpan({
            "orchestration_v2.command_id": command.commandId,
            "orchestration_v2.command_type": command.type,
            "orchestration_v2.thread_id":
              command.type === "thread.fork" || command.type === "thread.merge_back"
                ? command.targetThreadId
                : command.type === "delegated_task.request" ||
                    command.type === "delegated_task.wake-policy" ||
                    command.type === "delegated_task.completion-delivery.acknowledge" ||
                    command.type === "delegated_task.completion-delivery.dispose" ||
                    command.type === "thread.created.record"
                  ? command.parentThreadId
                  : command.threadId,
            ...(command.type === "thread.fork" || command.type === "thread.merge_back"
              ? { "orchestration_v2.source_thread_id": command.sourceThreadId }
              : {}),
          }).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                // A message may reference attachments the client streamed up
                // before sending; those live outside any thread until now.
                const claim =
                  command.type === "message.dispatch"
                    ? yield* AttachmentClaims.claimPendingAttachments({
                        threadId: command.threadId,
                        attachments: command.attachments,
                      })
                    : null;
                // A new Scratch thread that names no folder gets its own.
                const preparedCommand =
                  command.type === "thread.create" && command.worktreePath === null
                    ? yield* scratchProject
                        .threadFolder({
                          projectId: command.projectId,
                          threadId: command.threadId,
                          text: command.title,
                        })
                        .pipe(
                          Effect.map((worktreePath) =>
                            worktreePath === null ? command : { ...command, worktreePath },
                          ),
                        )
                    : command;
                const claimedCommand =
                  claim === null ? preparedCommand : { ...command, attachments: claim.attachments };
                return yield* startup
                  .enqueueCommand(
                    // A retry also restarts the preparation work the launch owns.
                    claimedCommand.type === "prepared-run.retry"
                      ? threadLaunch.retryPreparation(claimedCommand)
                      : threadManagement.dispatch(
                          ThreadManagementService.withCreationProvenance(claimedCommand, {
                            createdBy: "user",
                            creationSource:
                              "creationSource" in claimedCommand
                                ? claimedCommand.creationSource
                                : "web",
                          }),
                        ),
                  )
                  .pipe(
                    Effect.tapError(() =>
                      AttachmentClaims.releaseClaimedAttachments(claim?.claimedPaths ?? []),
                    ),
                  );
              }).pipe(
                Effect.tap(() => recordClientCommandAnalytics(command)),
                Effect.map((result) => ({ sequence: result.sequence })),
                Effect.mapError((cause) => {
                  const detail = userFacingDispatchErrorMessage(cause);
                  return new OrchestrationV2DispatchCommandError({
                    commandId: command.commandId,
                    commandType: command.type,
                    message: detail ?? "Failed to dispatch orchestration V2 command",
                    ...(detail === undefined ? {} : { detail }),
                    cause,
                  });
                }),
              ),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: (input) =>
          checkpointDiffQuery.getTurnDiff(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetTurnDiffError({
                  message: "Failed to load turn diff",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: (input) =>
          checkpointDiffQuery.getFullThreadDiff(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetFullThreadDiffError({
                  message: "Failed to load full thread diff",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.searchThreads]: (input) =>
          threadSearchQuery.searchThreads(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationSearchThreadsError({
                  message: "Failed to search threads",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          getOrchestrationV2ArchivedShellSnapshot,
        [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (input) =>
          Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
            Effect.andThen(
              threadManagement.getThreadProjection(input.threadId).pipe(
                Effect.map(projectThreadProjectionForWire),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationV2GetThreadProjectionError({
                      threadId: input.threadId,
                      message: `Failed to load orchestration V2 thread ${input.threadId}`,
                      cause,
                    }),
                ),
              ),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input) =>
          Effect.annotateCurrentSpan({
            "orchestration_v2.command_id": input.commandId,
            "orchestration_v2.project_id": input.projectId,
          }).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                yield* AttachmentClaims.validateAttachmentLimits(
                  input.initialMessage?.attachments ?? [],
                );
                const workspaceStrategy = yield* scratchProject.launchWorkspaceStrategy({
                  ...input,
                  text: input.initialMessage?.text ?? input.title,
                });
                // launch allocates the thread id, so a pending upload can only be
                // claimed once the caller has named one. Callers that let the
                // server pick the id must send the attachment with the follow-up
                // message instead.
                const claim =
                  input.threadId === undefined || input.initialMessage === undefined
                    ? null
                    : yield* AttachmentClaims.claimPendingAttachments({
                        threadId: input.threadId,
                        attachments: input.initialMessage.attachments,
                      });
                return yield* startup
                  .enqueueCommand(
                    threadLaunch.launch({
                      commandId: input.commandId,
                      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                      ...(input.reuseExistingThread === undefined
                        ? {}
                        : { reuseExistingThread: input.reuseExistingThread }),
                      projectId: input.projectId,
                      title: input.title,
                      modelSelection: input.modelSelection,
                      runtimeMode: input.runtimeMode,
                      interactionMode: input.interactionMode,
                      workspaceStrategy,
                      ...(input.prepareWorkspace === undefined
                        ? {}
                        : { prepareWorkspace: input.prepareWorkspace }),
                      ...(input.initialMessage === undefined
                        ? {}
                        : {
                            initialMessage: {
                              ...(input.initialMessage.messageId === undefined
                                ? {}
                                : { messageId: input.initialMessage.messageId }),
                              text: input.initialMessage.text,
                              attachments: claim?.attachments ?? input.initialMessage.attachments,
                            },
                          }),
                      createdBy: "user",
                      creationSource: input.creationSource ?? "web",
                    }),
                  )
                  .pipe(
                    Effect.tapError(() =>
                      AttachmentClaims.releaseClaimedAttachments(claim?.claimedPaths ?? []),
                    ),
                  );
              }).pipe(
                Effect.tap(() =>
                  input.initialMessage === undefined
                    ? analytics.record("client.thread.started", clientAnalyticsProps)
                    : Effect.andThen(
                        analytics.record("client.thread.started", clientAnalyticsProps),
                        analytics.record("client.turn.requested", clientAnalyticsProps),
                      ),
                ),
                Effect.map((result) => ({
                  ...result,
                  projection: projectThreadProjectionForWire(result.projection),
                })),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationV2ThreadLaunchError({
                      commandId: input.commandId,
                      projectId: input.projectId,
                      // Attachment and folder failures say why.
                      message:
                        cause._tag === "AttachmentClaimError" ||
                        cause._tag === "ProjectProvisionError"
                          ? cause.message
                          : "Failed to launch thread",
                      cause,
                    }),
                ),
              ),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: (input) =>
          readWorkflowScript({ scriptPath: input.scriptPath }),
        [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: (input) =>
          Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
            Effect.andThen(
              threadManagement.getTurnItem(input).pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationV2GetThreadProjectionError({
                      threadId: input.threadId,
                      message: "Failed to load turn item",
                      cause,
                    }),
                ),
              ),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.generateHandoffScript]: (input) =>
          Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const projection = yield* threadManagement.getThreadProjection(input.threadId);
                const project = yield* projectService.getById(projection.thread.projectId);
                const cwd =
                  projection.thread.worktreePath ??
                  (Option.isSome(project) ? project.value.workspaceRoot : null);
                const transcript = makeThreadHandoffTranscript(projection.messages);
                let summary: string | null = null;
                if (cwd !== null && transcript.length > 0) {
                  const generated = yield* Effect.result(
                    textGeneration
                      .generateHandoffSummary({
                        cwd,
                        transcript,
                        fromProvider: projection.thread.providerInstanceId,
                        toProvider: "a new agent session",
                        modelSelection: projection.thread.modelSelection,
                      })
                      .pipe(Effect.timeoutOption(HANDOFF_SCRIPT_SUMMARY_TIMEOUT_MS)),
                  );
                  if (generated._tag === "Success" && Option.isSome(generated.success)) {
                    const trimmed = generated.success.value.summary.trim();
                    summary = trimmed.length > 0 ? trimmed : null;
                  }
                  if (summary === null) {
                    yield* Effect.logWarning(
                      "Handoff script AI summary unavailable; falling back to transcript digest.",
                      { threadId: input.threadId },
                    );
                  }
                }
                return {
                  script: makeThreadHandoffScript({
                    title: projection.thread.title,
                    branch: projection.thread.branch,
                    worktreePath: projection.thread.worktreePath,
                    workspaceRoot: Option.isSome(project) ? project.value.workspaceRoot : null,
                    providerInstanceId: projection.thread.providerInstanceId,
                    summary,
                    messages: projection.messages,
                  }),
                  aiGenerated: summary !== null,
                };
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationV2GenerateHandoffScriptError({
                      threadId: input.threadId,
                      message: `Failed to generate handoff script for thread ${input.threadId}`,
                      cause,
                    }),
                ),
              ),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell]: (_input) =>
          Stream.unwrap(subscribeOrchestrationV2ArchivedShell()),
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) =>
          Stream.unwrap(subscribeOrchestrationV2Shell(input)),
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input) =>
          Stream.unwrap(
            Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
              Effect.andThen(subscribeOrchestrationV2Thread(input)),
            ),
          ),
        [WS_METHODS.scheduledTasksList]: (_input) =>
          scheduledTasks.list().pipe(Effect.map(withVisibleWebhookUrls)),
        [WS_METHODS.scheduledTasksSubscribe]: (_input) =>
          scheduledTasks.subscribeList().pipe(Stream.map(withVisibleWebhookUrls)),
        [WS_METHODS.scheduledTasksUpsert]: (input) => scheduledTasks.upsert(input),
        [WS_METHODS.scheduledTasksSetEnabled]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.setEnabled(input)),
          ),
        [WS_METHODS.scheduledTasksDelete]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.delete(input)),
          ),
        [WS_METHODS.scheduledTasksRunNow]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.runNow(input)),
          ),
        [WS_METHODS.scheduledTasksRotateWebhookToken]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.rotateWebhookToken(input)),
          ),
        [WS_METHODS.secretsAnswerRequest]: (input) =>
          Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
            Effect.andThen(secretRequests.answer(input)),
          ),
        [WS_METHODS.scheduledTasksListWebhookDeliveries]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.listWebhookDeliveries(input)),
          ),
        [WS_METHODS.scheduledTasksGetWebhookDelivery]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.getWebhookDelivery(input)),
          ),
        [WS_METHODS.hermesWorkSetupStart]: (input) => hermesSetup.start(input),
        [WS_METHODS.hermesWorkSetupStatus]: (input) => hermesSetup.status(input),
        [WS_METHODS.hermesWorkModelStatus]: (input) => hermesModelAuth.modelStatus(input),
        [WS_METHODS.hermesWorkModelAuthStart]: (input) => hermesModelAuth.modelAuthStart(input),
        [WS_METHODS.hermesWorkModelAuthPoll]: (input) => hermesModelAuth.modelAuthPoll(input),
        [WS_METHODS.hermesWorkModelAuthCancel]: (input) => hermesModelAuth.modelAuthCancel(input),
        [WS_METHODS.hermesWorkModelSet]: (input) => hermesModelAuth.modelSet(input),
        [WS_METHODS.hermesWorkConnections]: () => hermesDashboard.connections(),
        [WS_METHODS.hermesWorkSubscribeChanges]: (input) =>
          subscribeHermesWorkChanges(hermesDashboard, input),
        [WS_METHODS.hermesWorkQuery]: (input) => hermesWork.query(input),
        [WS_METHODS.hermesWorkMutate]: (input) => hermesWork.mutate(input),
        [WS_METHODS.hermesWorkGroupsQuery]: (input) => hermesWorkGroups.query(input),
        [WS_METHODS.hermesWorkGroupsMutate]: (input) => hermesWorkGroups.mutate(input),
        [WS_METHODS.serverProbe]: (_input) => Effect.succeed({}),
        [WS_METHODS.serverGetConfig]: (_input) => loadServerConfig,
        [WS_METHODS.serverRefreshProviders]: (input) =>
          Effect.gen(function* () {
            yield* bypassOwnedProviderCachesForRefresh(input);
            if (input.cwd !== undefined && input.instanceId !== undefined && !input.refreshModels) {
              // Workspace discovery is registry-owned: each cwd is scanned once
              // (again only when `fresh`), and selecting a thread never launches
              // a disposable provider health-check process.
              const providers = yield* providerRegistry.refreshWorkspaceSnapshot({
                instanceId: input.instanceId,
                cwd: input.cwd,
                fresh: input.fresh === true,
              });
              return { providers };
            }
            const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
            const candidates = (yield* instances.listInstances).filter(
              (instance) =>
                instance.enabled &&
                (input.instanceId === undefined || instance.instanceId === input.instanceId),
            );
            for (const instance of candidates) {
              const snapshot = yield* instance.snapshot.getSnapshot;
              if (input.refreshModels && snapshot.installed && instance.refreshModels) {
                yield* instance.refreshModels().pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderSetupError({
                        instanceId: instance.instanceId,
                        operation: "refreshModels",
                        detail: cause.message,
                        cause,
                      }),
                  ),
                );
              }
            }
            const providers = yield* input.instanceId !== undefined
              ? providerRegistry.refreshInstance(input.instanceId)
              : providerRegistry.refresh();
            yield* usageLimitSources.refresh;
            return { providers };
          }),
        [WS_METHODS.mcpAppsCallTool]: (input) => mcpAppRequests.callTool(input),
        [WS_METHODS.mcpAppsToolInfo]: (input) => mcpAppRequests.toolInfo(input),
        [WS_METHODS.mcpAppsUpdateModelContext]: (input) => mcpAppRequests.updateModelContext(input),
        [WS_METHODS.mcpAppsReadResource]: (input) => mcpAppRequests.readResource(input),
        [WS_METHODS.providerUploadFeedback]: (input) =>
          threadFeedback
            .upload({
              threadId: input.threadId,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderUploadFeedbackError({
                    threadId: input.threadId,
                    cause,
                  }),
              ),
            ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          providerMaintenanceRunner.updateProvider(input),
        [WS_METHODS.serverUpdateServer]: (input) => serverSelfUpdate.update(input),
        [WS_METHODS.serverUpdateServerWithProgress]: (input) =>
          Stream.callback<ServerSelfUpdateProgressEvent, ServerSelfUpdateError>((queue) =>
            serverSelfUpdate
              .update(input, (stage) =>
                Queue.offer(queue, {
                  type: "progress",
                  stage,
                }).pipe(Effect.asVoid),
              )
              .pipe(
                Effect.flatMap((result) =>
                  Queue.offer(queue, {
                    type: "complete",
                    result,
                  }),
                ),
                Effect.catchTags({
                  ServerSelfUpdateError: (error) => Queue.fail(queue, error),
                }),
                Effect.andThen(Queue.end(queue)),
                Effect.forkScoped,
              ),
          ),
        [WS_METHODS.serverCommitDesktopUpdate]: (input) =>
          serverSelfUpdate.commitDesktopUpdate(input.requestId),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          Effect.gen(function* () {
            const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
            return { keybindings: keybindingsConfig, issues: [] };
          }),
        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          Effect.gen(function* () {
            const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
            return { keybindings: keybindingsConfig, issues: [] };
          }),
        [WS_METHODS.serverGetSettings]: (_input) =>
          serverSettings.getSettings.pipe(Effect.map(ServerSettings.redactServerSettingsForClient)),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          serverSettings
            .updateSettings(patch)
            .pipe(Effect.map(ServerSettings.redactServerSettingsForClient)),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) => sourceControlDiscovery.discover,
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          TraceDiagnostics.readTraceDiagnostics({
            traceFilePath: config.serverTracePath,
            maxFiles: config.traceMaxFiles,
          }),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) => processDiagnostics.read,
        [WS_METHODS.serverGetHostResources]: (_input) => hostResources.read,
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          processResourceMonitor.readHistory(input),
        [WS_METHODS.serverGetResourceTelemetryHistory]: (input) =>
          resourceTelemetry.readHistory(input),
        [WS_METHODS.providerAuthStart]: (input) => providerAuth.start(input, currentSessionId),
        [WS_METHODS.providerAuthRespond]: (input) =>
          Effect.annotateCurrentSpan({ instanceId: input.instanceId }).pipe(
            Effect.andThen(providerAuth.respond(input, currentSessionId)),
          ),
        [WS_METHODS.providerAuthComplete]: (input) =>
          providerAuth.complete(input, currentSessionId),
        [WS_METHODS.providerAuthCancel]: (input) => providerAuth.cancel(input, currentSessionId),
        [WS_METHODS.providerAuthLogout]: (input) => providerAuth.logout(input),
        [WS_METHODS.providerAuthSubscribe]: (input) =>
          providerAuth.subscribe(input, currentSessionId),
        [WS_METHODS.providerInstallStart]: (input) => providerInstallation.start(input),
        [WS_METHODS.providerInstallCancel]: (input) => providerInstallation.cancel(input),
        [WS_METHODS.providerInstallSubscribe]: (input) => providerInstallation.subscribe(input),
        [WS_METHODS.providerInstallRemove]: (input) => providerInstallation.remove(input),
        [WS_METHODS.providerConsumeResetCredit]: (input) =>
          Effect.gen(function* () {
            if ("sourceId" in input) return yield* usageLimitSources.consumeResetCredit(input);
            const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
            const instance = yield* providerInstances.getInstance(input.instanceId);
            return yield* consumeInstanceResetCredit(instance, input);
          }),
        [WS_METHODS.serverGetUsageSummary]: (input) => usage.readSummary(input),
        [WS_METHODS.serverRefreshUsageRates]: (_input) => usage.refreshRates,
        [WS_METHODS.serverRetryResourceTelemetry]: (_input) => resourceTelemetry.retry,
        [WS_METHODS.serverSignalProcess]: (input) => processDiagnostics.signal(input),
        [WS_METHODS.serverReportClientActivity]: (input, metadata) =>
          Ref.update(rpcClientIds, (clientIds) => {
            const next = new Set(clientIds);
            next.add(RpcClientId.make(metadata.client.id));
            return next;
          }).pipe(
            Effect.andThen(
              backgroundPolicy.reportClientActivity(
                currentSessionId,
                RpcClientId.make(metadata.client.id),
                input,
              ),
            ),
          ),
        [WS_METHODS.serverReportHostPowerState]: (input) =>
          backgroundPolicy.reportHostPowerState(input),
        [WS_METHODS.serverGetBackgroundPolicy]: (_input) => backgroundPolicy.snapshot,
        [WS_METHODS.cloudGetRelayClientStatus]: (_input) => relayClient.resolve,
        [WS_METHODS.cloudInstallRelayClient]: (_input) =>
          Stream.callback<RelayClientInstallProgressEvent, RelayClientInstallFailedError>((queue) =>
            relayClient
              .installWithProgress((event) => Queue.offer(queue, event).pipe(Effect.asVoid))
              .pipe(
                Effect.flatMap((status) =>
                  Queue.offer(queue, {
                    type: "complete",
                    status,
                  }),
                ),
                Effect.catchTags({
                  RelayClientInstallError: (error) =>
                    Queue.fail(
                      queue,
                      new RelayClientInstallFailedError({
                        reason: error.reason,
                        message: error.message,
                      }),
                    ),
                }),
                Effect.andThen(Queue.end(queue)),
                Effect.forkScoped,
              ),
          ),
        [WS_METHODS.pullRequestsList]: (input) => pullRequests.list(input),
        [WS_METHODS.pullRequestsListStats]: (input) => pullRequests.listStats(input),
        [WS_METHODS.pullRequestsStack]: (input) => pullRequests.stack(input),
        [WS_METHODS.pullRequestsDetail]: (input) => pullRequests.detail(input),
        [WS_METHODS.pullRequestsActivity]: (input) => pullRequests.activity(input),
        [WS_METHODS.pullRequestsThreadComments]: (input) => pullRequests.threadComments(input),
        [WS_METHODS.pullRequestsDiffFileContents]: (input) => pullRequests.diffFileContents(input),
        [WS_METHODS.pullRequestsRunAction]: (input) => pullRequests.runAction(input),
        [WS_METHODS.pullRequestsUpdate]: (input) => pullRequests.update(input),
        [WS_METHODS.pullRequestsComment]: (input) => pullRequests.comment(input),
        [WS_METHODS.pullRequestsUpdateComment]: (input) => pullRequests.updateComment(input),
        [WS_METHODS.pullRequestsSubmitReview]: (input) => pullRequests.submitReview(input),
        [WS_METHODS.pullRequestsReplyToThread]: (input) => pullRequests.replyToThread(input),
        [WS_METHODS.pullRequestsSetThreadResolution]: (input) =>
          pullRequests.setThreadResolution(input),
        [WS_METHODS.pullRequestsSetReaction]: (input) => pullRequests.setReaction(input),
        [WS_METHODS.pullRequestsInvalidate]: (input) => pullRequests.invalidate(input),
        [WS_METHODS.pullRequestsLabelCandidates]: (input) => pullRequests.labelCandidates(input),
        [WS_METHODS.pullRequestsSetLabels]: (input) => pullRequests.setLabels(input),
        [WS_METHODS.pullRequestsReviewerCandidates]: (input) =>
          pullRequests.reviewerCandidates(input),
        [WS_METHODS.pullRequestsRequestReviewers]: (input) => pullRequests.requestReviewers(input),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          sourceControlRepositories.lookupRepository(input),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          sourceControlRepositories.cloneRepository(input),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          sourceControlRepositories.publishRepository(input).pipe(
            // A new remote can change the cached identity. Only the `cwd` entry
            // refreshes, so after a publish from a linked worktree the project
            // root entry waits for its TTL.
            Effect.tap(() => repositoryIdentityResolver.resolve(input.cwd, { refresh: true })),
            Effect.tap(() => refreshGitStatus(input.cwd)),
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          workspaceEntries.search(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectSearchEntriesError({
                  cwd: input.cwd,
                  queryLength: input.query.length,
                  limit: input.limit,
                  ...projectEntriesFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsSearchContents]: (input) =>
          workspaceEntries.searchContents(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectSearchContentsError({
                  cwd: input.cwd,
                  queryLength: input.query.length,
                  limit: input.limit,
                  ...projectEntriesFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsListEntries]: (input) =>
          workspaceEntries.list(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectListEntriesError({
                  ...input,
                  ...projectEntriesFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          workspaceFileSystem.readFile(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectReadFileError({
                  ...input,
                  ...projectFileFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          workspaceFileSystem.writeFile(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectWriteFileError({
                  cwd: input.cwd,
                  relativePath: input.relativePath,
                  ...projectFileFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsMutate]: (mutation) =>
          startup.enqueueCommand(mutateProject(mutation)).pipe(
            Effect.mapError((cause) =>
              cause._tag === "ProjectMutationError"
                ? cause
                : new ProjectMutationError({
                    commandId: mutation.commandId,
                    message: "Failed to mutate project.",
                    cause,
                  }),
            ),
          ),
        [WS_METHODS.projectsEnsureScratch]: () =>
          startup
            .enqueueCommand(scratchProject.ensureProject)
            .pipe(
              Effect.mapError((cause) =>
                cause._tag === "ProjectProvisionError"
                  ? cause
                  : new ProjectProvisionError({ message: cause.message, cause }),
              ),
            ),
        [WS_METHODS.projectsCreateNew]: (input) =>
          startup
            .enqueueCommand(createNewProject(input))
            .pipe(
              Effect.mapError((cause) =>
                cause._tag === "ProjectProvisionError"
                  ? cause
                  : new ProjectProvisionError({ message: cause.message, cause }),
              ),
            ),
        [WS_METHODS.shellOpenInEditor]: (input) => externalLauncher.launchEditor(input),
        [WS_METHODS.agentSessionsScan]: () => agentSessionScanner.scan,
        [WS_METHODS.agentSessionsImport]: (input) => agentSessionImporter.importRecent(input),
        [WS_METHODS.filesystemBrowse]: (input) =>
          workspaceEntries.browse(input).pipe(
            Effect.mapError(
              (cause) =>
                new FilesystemBrowseError({
                  ...input,
                  ...filesystemBrowseFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.attachmentsCreateUploadUrl]: (input) => issueAttachmentUploadUrl(input),
        [WS_METHODS.attachmentsDelete]: (input) => deletePendingAttachment(input.attachmentId),
        [WS_METHODS.assetsCreateUrl]: (input) =>
          Effect.gen(function* () {
            if (input.resource._tag === "project-favicon") {
              const project = yield* projectService.getByWorkspaceRoot(input.resource.cwd).pipe(
                Effect.mapError(
                  (cause) =>
                    new AssetWorkspaceContextResolutionError({
                      resource: input.resource,
                      cause,
                    }),
                ),
              );
              if (Option.isNone(project)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              return yield* issueAssetUrl({
                resource: input.resource,
                ...(project.value.faviconPath
                  ? { projectFaviconPath: project.value.faviconPath }
                  : {}),
              });
            }
            if (input.resource._tag !== "workspace-file" && input.resource._tag !== "media-file") {
              return yield* issueAssetUrl({ resource: input.resource });
            }
            const thread = yield* threadManagement
              .getThreadRecords(input.resource.threadId, [])
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new AssetWorkspaceContextResolutionError({
                      resource: input.resource,
                      cause,
                    }),
                ),
              );
            const project = yield* projectService.getById(thread.thread.projectId).pipe(
              Effect.mapError(
                (cause) =>
                  new AssetWorkspaceContextResolutionError({
                    resource: input.resource,
                    cause,
                  }),
              ),
            );
            if (Option.isNone(project)) {
              return yield* new AssetWorkspaceContextNotFoundError({
                resource: input.resource,
              });
            }
            return yield* issueAssetUrl({
              resource: input.resource,
              workspaceRoot: thread.thread.worktreePath ?? project.value.workspaceRoot,
            });
          }),
        [WS_METHODS.assetsPersistChatAttachments]: (input) =>
          persistChatAttachments(input).pipe(Effect.map((attachments) => ({ attachments }))),
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          vcsStatusBroadcaster.streamStatus(input, {
            automaticRemoteRefreshInterval: automaticGitFetchInterval,
          }),
        [WS_METHODS.vcsRefreshStatus]: (input) => vcsStatusBroadcaster.refreshStatus(input.cwd),
        [WS_METHODS.vcsRefreshLocalStatus]: (input) =>
          vcsStatusBroadcaster.refreshLocalStatus(input.cwd),
        [WS_METHODS.vcsPull]: (input) =>
          gitWorkflow.pullCurrentBranch(input.cwd).pipe(
            Effect.matchCauseEffect({
              onFailure: (cause) => Effect.failCause(cause),
              onSuccess: (result) =>
                refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
            }),
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
            withCreatedPullRequestLink(
              input,
              gitWorkflow.runStackedAction(input, {
                actionId: input.actionId,
                progressReporter: {
                  publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                },
              }),
            ).pipe(
              Effect.provideService(
                ThreadManagementService.ThreadManagementService,
                threadManagement,
              ),
              Effect.provideService(ProjectService.ProjectService, projectService),
              Effect.provideService(Path.Path, path),
              Effect.matchCauseEffect({
                onFailure: (cause) => Queue.failCause(queue, cause),
                onSuccess: () =>
                  refreshGitStatus(input.cwd).pipe(
                    Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                  ),
              }),
            ),
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) => gitWorkflow.resolvePullRequest(input),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          gitWorkflow
            .preparePullRequestThread(input)
            .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.vcsListRefs]: (input) => gitWorkflow.listRefs(input),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          gitWorkflow.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.vcsCreateRef]: (input) =>
          gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.vcsInit]: (input) =>
          vcsProvisioning.initRepository(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.reviewGetDiffPreview]: (input) => review.getDiffPreview(input),
        [WS_METHODS.reviewGetDiffFileContents]: (input) => review.getDiffFileContents(input),
        [WS_METHODS.terminalOpen]: (input) => terminalManager.open(input),
        [WS_METHODS.terminalAttach]: (input) =>
          Stream.callback<TerminalAttachStreamEvent, TerminalError>((queue) =>
            Effect.acquireRelease(
              terminalManager.attachStream(input, (event) => Queue.offer(queue, event)),
              (unsubscribe) => Effect.sync(unsubscribe),
            ).pipe(Effect.catchCause((cause) => Queue.failCause(queue, cause))),
          ),
        [WS_METHODS.terminalWrite]: (input) => terminalManager.write(input),
        [WS_METHODS.terminalResize]: (input) => terminalManager.resize(input),
        [WS_METHODS.terminalClear]: (input) => terminalManager.clear(input),
        [WS_METHODS.terminalRestart]: (input) => terminalManager.restart(input),
        [WS_METHODS.terminalClose]: (input) => terminalManager.close(input),
        [WS_METHODS.terminalObserve]: (input) =>
          Stream.callback<TerminalAttachStreamEvent, TerminalError>((queue) =>
            Effect.acquireRelease(
              terminalManager.observeStream(input, (event) => Queue.offer(queue, event)),
              (unsubscribe) => Effect.sync(unsubscribe),
            ).pipe(Effect.catchCause((cause) => Queue.failCause(queue, cause))),
          ),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          Stream.callback<TerminalEvent>((queue) =>
            Effect.acquireRelease(
              terminalManager.subscribe((event) => Queue.offer(queue, event)),
              (unsubscribe) => Effect.sync(unsubscribe),
            ),
          ),
        [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
          Stream.callback<TerminalMetadataStreamEvent>((queue) =>
            Effect.acquireRelease(
              terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
              (unsubscribe) => Effect.sync(unsubscribe),
            ),
          ),
        [WS_METHODS.previewOpen]: (input) => previewManager.open(input),
        [WS_METHODS.previewNavigate]: (input) => previewManager.navigate(input),
        [WS_METHODS.previewResize]: (input) => previewManager.resize(input),
        [WS_METHODS.previewRefresh]: (input) => previewManager.refresh(input),
        [WS_METHODS.previewClose]: (input) => previewManager.close(input),
        [WS_METHODS.previewList]: (input) => previewManager.list(input),
        [WS_METHODS.previewReportStatus]: (input) => previewManager.reportStatus(input),
        [WS_METHODS.previewAutomationConnect]: (input) =>
          Stream.unwrap(previewAutomationBroker.connect(input)),
        [WS_METHODS.previewAutomationRespond]: (input) => previewAutomationBroker.respond(input),
        [WS_METHODS.previewAutomationFocusHost]: (input) =>
          previewAutomationBroker.focusHost(input),
        [WS_METHODS.subscribePreviewEvents]: (_input) => previewManager.events,
        [WS_METHODS.subscribeDiscoveredLocalServers]: (input) =>
          Stream.callback<DiscoveredLocalServerList>((queue) =>
            Effect.gen(function* () {
              const configuredUrls = input.configuredUrls ?? [];
              yield* portDiscovery.retain;
              const initial = yield* portDiscovery.scan(configuredUrls);
              const initialScannedAt = DateTime.formatIso(yield* DateTime.now);
              yield* Queue.offer(queue, {
                servers: initial,
                scannedAt: initialScannedAt,
                configuredUrlProbing: true,
              });
              yield* portDiscovery.subscribe(
                { configuredUrls, initialSnapshot: initial },
                (servers) =>
                  Effect.gen(function* () {
                    const scannedAt = DateTime.formatIso(yield* DateTime.now);
                    yield* Queue.offer(queue, {
                      servers,
                      scannedAt,
                      configuredUrlProbing: true,
                    });
                  }),
              );
            }),
          ),
        [WS_METHODS.subscribeServerConfig]: (input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              // The only source of published themes: the stream emits the
              // current set before any change, so the snapshot carrying it too
              // would just send every client the same array twice per connect.
              // Gated on the subscriber's capability flag because an
              // already-shipped client decodes this stream against the old
              // event union and its whole config subscription dies on an
              // unknown member.
              const environmentThemeUpdates =
                input.environmentThemes === true
                  ? environmentTheme.streamChanges.pipe(
                      Stream.map((themes) => ({
                        version: 1 as const,
                        type: "environmentThemesUpdated" as const,
                        payload: { themes },
                      })),
                    )
                  : Stream.empty;
              const usageSourceUpdates =
                input.usageLimitSources === true
                  ? usageLimitSources.streamChanges.pipe(
                      Stream.map((sources) => ({
                        version: 1 as const,
                        type: "usageLimitSourcesUpdated" as const,
                        payload: { sources },
                      })),
                    )
                  : Stream.empty;
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => ServerSettings.redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(
                  providerStatuses,
                  Stream.merge(
                    settingsUpdates,
                    Stream.merge(environmentThemeUpdates, usageSourceUpdates),
                  ),
                ),
              );

              const snapshotConfig = yield* loadServerConfig;
              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: snapshotConfig,
                }),
                withLateEditorConfig(snapshotConfig, liveUpdates, externalLauncher),
              );
            }),
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = lifecycleEvents.stream.pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
          ),
        [WS_METHODS.subscribeBackgroundPolicy]: (_input) =>
          Stream.unwrap(
            Effect.map(backgroundPolicy.subscribe, ({ latest, changes }) =>
              Stream.concat(Stream.make(latest), changes),
            ),
          ),
        [WS_METHODS.subscribeResourceTelemetry]: (_input) =>
          Stream.unwrap(
            Effect.map(resourceTelemetry.subscribe, ({ latest, changes }) =>
              Stream.concat(Stream.make(latest), changes),
            ),
          ),
      });
      return handlers;
    }),
  );

// A defect in a handler's effect fails only its own request. RpcServer's default
// sends a socket-level Defect frame instead, and the client ends every pending
// request on the socket with it. DefectReporter logs these defects.
export const WS_RPC_SERVER_OPTIONS = {
  disableTracing: true,
  disableFatalDefects: true,
} as const;

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const previewAutomationBroker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    const pullRequests = yield* PullRequestService.PullRequestService;
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const requestUrl = HttpServerRequest.toURL(request);
        if (Option.isSome(requestUrl) && !hasCompatibleOrchestrationProtocol(requestUrl.value)) {
          return HttpServerResponse.jsonUnsafe(
            {
              code: "orchestration_protocol_incompatible",
              message: `Update this client to one that supports orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`,
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
            },
            { status: 426 },
          );
        }
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const analytics = yield* AnalyticsService.AnalyticsService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        const clientOrigin = readClientConnectionOrigin(request);
        const clientAnalyticsProps = readClientAnalyticsProps(request);
        yield* sessions.recordClientConnection(session.sessionId, clientOrigin);
        yield* analytics.record("client.connected", clientAnalyticsProps);
        const rpcWebSocketHttpEffect = yield* Effect.gen(function* () {
          const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
          yield* RpcServer.make(ServerWsRpcGroup, WS_RPC_SERVER_OPTIONS).pipe(
            Effect.provideService(RpcServer.Protocol, withTerminalOutputWindow(protocol)),
            Effect.provide(
              Layer.merge(rpcScopeAuthorizationLayer(session.scopes), rpcInstrumentationLayer),
            ),
            Effect.forkScoped,
          );
          // @effect-diagnostics-next-line returnEffectInGen:off
          return httpEffect;
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(
              session,
              clientOrigin,
              clientAnalyticsProps,
              previewAutomationBroker,
            ).pipe(
              Layer.provideMerge(RpcSerialization.layerJson),
              // Request fibers run in the handlers' context, so this reporter sees
              // their defects, not the rest of the server's.
              Layer.provide(DefectReporter.layer),
              Layer.provide(ProviderMaintenanceRunner.layer),
              Layer.provide(Layer.succeed(ServerSelfUpdate.ServerSelfUpdate, serverSelfUpdate)),
              // One server-lifetime service means clients share the same PR caches, and a WS
              // mutation invalidates the HTTP diff cache that every client reads from.
              Layer.provide(Layer.succeed(PullRequestService.PullRequestService, pullRequests)),
              Layer.provide(
                SourceControlDiscovery.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(
                        Layer.mergeAll(
                          AzureDevOpsCli.layer,
                          BitbucketApi.layer,
                          GitHubRepositoryApi.layer,
                          GitLabCli.layer,
                        ),
                      ),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                  Layer.provide(VcsProcess.layer),
                ),
              ),
            ),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);
