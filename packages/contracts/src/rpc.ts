import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import {
  AudioTranscriptionError,
  AudioTranscriptionInput,
  AudioTranscriptionResult,
} from "./audioTranscription.ts";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  BrowserAgentActivateAnnotationInput,
  BrowserAgentAttachActiveTabInput,
  BrowserAgentCommandError,
  BrowserAgentCommandResult,
  BrowserAgentListResult,
  BrowserAgentOpenOrFocusPreviewInput,
  BrowserAgentOpenOrFocusThreadTabInput,
  BrowserAgentRuntimeCommandInput,
  BrowserAgentSetThreadTabControlInput,
  BrowserAgentStartThreadTabCaptureInput,
  BrowserAgentStreamEvent,
  BrowserAgentThreadLinkInput,
  BrowserAgentThreadTabInputCommandInput,
  BrowserAgentThreadTabNavigateInput,
} from "./browserAgent.ts";
import {
  OrganizationPanelError,
  OrganizationPanelDynamicRpcInvokeInput,
  OrganizationPanelDynamicRpcInvokeResult,
  OrganizationPanelDynamicRpcListInput,
  OrganizationPanelDynamicRpcListResult,
  OrganizationPanelEventsSubscribeInput,
  OrganizationPanelEvent,
  OrganizationPanelGetInput,
  OrganizationPanelGetResult,
  OrganizationPanelHistoryListInput,
  OrganizationPanelHistoryListResult,
  OrganizationPanelRollbackInput,
  OrganizationPanelRollbackResult,
  OrganizationPanelTurnStartInput,
  OrganizationPanelTurnStartResult,
  OrganizationPanelTurnStopInput,
  OrganizationPanelTurnStopResult,
} from "./organizationPanel.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import {
  WorkspaceCreateDirectoryInput,
  WorkspaceCreateFileInput,
  WorkspaceDeleteInput,
  WorkspaceFileChangeEvent,
  WorkspaceFileError,
  WorkspaceListDirectoryInput,
  WorkspaceListDirectoryResult,
  WorkspaceMutationResult,
  WorkspaceReadFileInput,
  WorkspaceReadFileResult,
  WorkspaceRenameInput,
  WorkspaceRenameResult,
  WorkspaceWatchInput,
  WorkspaceWriteFileInput,
  WorkspaceWriteFileResult,
} from "./workspaceFiles.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsSyncBaseInput,
  VcsSyncBaseResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  VcsStatusInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";
import {
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
  ReviewPullRequestCommentsError,
  ReviewPullRequestCommentsInput,
  ReviewPullRequestCommentsResult,
} from "./review.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationRpcSchemas,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  RelayClientInstallFailedError,
  RelayClientInstallProgressEventSchema,
  RelayClientStatusSchema,
} from "./relayClient.ts";
import {
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalDetectWebServersInput,
  TerminalDetectWebServersResult,
  TerminalError,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  ProviderSlashCommandsListError,
  ProviderSlashCommandsListInput,
  ProviderSlashCommandsListResult,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsSearchEntries: "projects.searchEntries",
  projectsReadFile: "projects.readFile",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",

  // Workspace file manager methods
  workspaceFilesListDirectory: "workspaceFiles.listDirectory",
  workspaceFilesReadFile: "workspaceFiles.readFile",
  workspaceFilesWriteFile: "workspaceFiles.writeFile",
  workspaceFilesCreateFile: "workspaceFiles.createFile",
  workspaceFilesCreateDirectory: "workspaceFiles.createDirectory",
  workspaceFilesRename: "workspaceFiles.rename",
  workspaceFilesDelete: "workspaceFiles.delete",
  workspaceFilesSubscribeChanges: "workspaceFiles.subscribeChanges",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsSyncBase: "vcs.syncBase",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",
  gitMarkPullRequestReadyForReview: "git.markPullRequestReadyForReview",

  // Review methods
  reviewGetDiffPreview: "review.getDiffPreview",
  reviewListPullRequestComments: "review.listPullRequestComments",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",
  terminalDetectWebServers: "terminal.detectWebServers",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverSignalProcess: "server.signalProcess",
  serverTranscribeAudio: "server.transcribeAudio",

  // Provider metadata
  providerListSlashCommands: "provider.slashCommands.list",

  // Cloud environment methods
  cloudGetRelayClientStatus: "cloud.getRelayClientStatus",
  cloudInstallRelayClient: "cloud.installRelayClient",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",

  // Browser agent methods
  browserAgentsList: "browserAgents.list",
  browserAgentsOpenOrFocusPreview: "browserAgents.openOrFocusPreview",
  browserAgentsActivateAnnotation: "browserAgents.activateAnnotation",
  browserAgentsOpenOrFocusThreadTab: "browserAgents.threadTab.openOrFocus",
  browserAgentsAttachActiveTab: "browserAgents.threadTab.attachActive",
  browserAgentsDetachThreadTab: "browserAgents.threadTab.detach",
  browserAgentsSetThreadTabControl: "browserAgents.threadTab.setControl",
  browserAgentsStartThreadTabCapture: "browserAgents.threadTab.capture.start",
  browserAgentsStopThreadTabCapture: "browserAgents.threadTab.capture.stop",
  browserAgentsBackThreadTab: "browserAgents.threadTab.back",
  browserAgentsForwardThreadTab: "browserAgents.threadTab.forward",
  browserAgentsReloadThreadTab: "browserAgents.threadTab.reload",
  browserAgentsNavigateThreadTab: "browserAgents.threadTab.navigate",
  browserAgentsInputThreadTab: "browserAgents.threadTab.input",
  browserAgentsSnapshotThreadTab: "browserAgents.threadTab.snapshot",
  browserAgentsScreenshotThreadTab: "browserAgents.threadTab.screenshot",
  browserAgentsRuntimeCommand: "browserAgents.runtime.command",

  // Organization panel methods
  organizationPanelGet: "organizationPanel.get",
  organizationPanelTurnStart: "organizationPanel.turn.start",
  organizationPanelTurnStop: "organizationPanel.turn.stop",
  organizationPanelHistoryList: "organizationPanel.history.list",
  organizationPanelRollback: "organizationPanel.rollback",
  organizationPanelDynamicRpcList: "organizationPanel.dynamic.list",
  organizationPanelDynamicRpcInvoke: "organizationPanel.dynamic.invoke",
  subscribeOrganizationPanelEvents: "organizationPanel.event",

  // Streaming subscriptions
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  subscribeBrowserAgents: "subscribeBrowserAgents",
} as const;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
  }),
  success: ServerProviderUpdatedPayload,
  error: EnvironmentAuthorizationError,
});

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([ServerProviderUpdateError, EnvironmentAuthorizationError]),
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessResourceHistoryRpc = Rpc.make(
  WS_METHODS.serverGetProcessResourceHistory,
  {
    payload: ServerProcessResourceHistoryInput,
    success: ServerProcessResourceHistoryResult,
    error: EnvironmentAuthorizationError,
  },
);

export const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
  error: EnvironmentAuthorizationError,
});

export const WsCloudGetRelayClientStatusRpc = Rpc.make(WS_METHODS.cloudGetRelayClientStatus, {
  payload: Schema.Struct({}),
  success: RelayClientStatusSchema,
  error: EnvironmentAuthorizationError,
});

export const WsCloudInstallRelayClientRpc = Rpc.make(WS_METHODS.cloudInstallRelayClient, {
  payload: Schema.Struct({}),
  success: RelayClientInstallProgressEventSchema,
  error: Schema.Union([RelayClientInstallFailedError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsServerTranscribeAudioRpc = Rpc.make(WS_METHODS.serverTranscribeAudio, {
  payload: AudioTranscriptionInput,
  success: AudioTranscriptionResult,
  error: Schema.Union([AudioTranscriptionError, EnvironmentAuthorizationError]),
});

export const WsProviderListSlashCommandsRpc = Rpc.make(WS_METHODS.providerListSlashCommands, {
  payload: ProviderSlashCommandsListInput,
  success: ProviderSlashCommandsListResult,
  error: Schema.Union([ProviderSlashCommandsListError, EnvironmentAuthorizationError]),
});

export const WsSourceControlLookupRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlLookupRepository,
  {
    payload: SourceControlRepositoryLookupInput,
    success: SourceControlRepositoryInfo,
    error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
  },
);

export const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

export const WsSourceControlPublishRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlPublishRepository,
  {
    payload: SourceControlPublishRepositoryInput,
    success: SourceControlPublishRepositoryResult,
    error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
  },
);

export const WsBrowserAgentsListRpc = Rpc.make(WS_METHODS.browserAgentsList, {
  payload: Schema.Struct({}),
  success: BrowserAgentListResult,
  error: EnvironmentAuthorizationError,
});

export const WsBrowserAgentsOpenOrFocusPreviewRpc = Rpc.make(
  WS_METHODS.browserAgentsOpenOrFocusPreview,
  {
    payload: BrowserAgentOpenOrFocusPreviewInput,
    success: BrowserAgentCommandResult,
    error: Schema.Union([BrowserAgentCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsBrowserAgentsActivateAnnotationRpc = Rpc.make(
  WS_METHODS.browserAgentsActivateAnnotation,
  {
    payload: BrowserAgentActivateAnnotationInput,
    success: BrowserAgentCommandResult,
    error: Schema.Union([BrowserAgentCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsBrowserAgentsOpenOrFocusThreadTabRpc = Rpc.make(
  WS_METHODS.browserAgentsOpenOrFocusThreadTab,
  {
    payload: BrowserAgentOpenOrFocusThreadTabInput,
    success: BrowserAgentCommandResult,
    error: Schema.Union([BrowserAgentCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsBrowserAgentsAttachActiveTabRpc = Rpc.make(WS_METHODS.browserAgentsAttachActiveTab, {
  payload: BrowserAgentAttachActiveTabInput,
  success: BrowserAgentCommandResult,
  error: Schema.Union([BrowserAgentCommandError, EnvironmentAuthorizationError]),
});

export const WsBrowserAgentsDetachThreadTabRpc = Rpc.make(WS_METHODS.browserAgentsDetachThreadTab, {
  payload: BrowserAgentThreadLinkInput,
  success: BrowserAgentCommandResult,
  error: Schema.Union([BrowserAgentCommandError, EnvironmentAuthorizationError]),
});

export const WsBrowserAgentsSetThreadTabControlRpc = Rpc.make(
  WS_METHODS.browserAgentsSetThreadTabControl,
  {
    payload: BrowserAgentSetThreadTabControlInput,
    success: BrowserAgentCommandResult,
    error: Schema.Union([BrowserAgentCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsBrowserAgentsStartThreadTabCaptureRpc = Rpc.make(
  WS_METHODS.browserAgentsStartThreadTabCapture,
  {
    payload: BrowserAgentStartThreadTabCaptureInput,
    success: BrowserAgentCommandResult,
    error: Schema.Union([BrowserAgentCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsBrowserAgentsStopThreadTabCaptureRpc = Rpc.make(
  WS_METHODS.browserAgentsStopThreadTabCapture,
  {
    payload: BrowserAgentThreadLinkInput,
    success: BrowserAgentCommandResult,
    error: Schema.Union([BrowserAgentCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsBrowserAgentsBackThreadTabRpc = Rpc.make(WS_METHODS.browserAgentsBackThreadTab, {
  payload: BrowserAgentThreadLinkInput,
  success: BrowserAgentCommandResult,
  error: Schema.Union([BrowserAgentCommandError, EnvironmentAuthorizationError]),
});

export const WsBrowserAgentsForwardThreadTabRpc = Rpc.make(
  WS_METHODS.browserAgentsForwardThreadTab,
  {
    payload: BrowserAgentThreadLinkInput,
    success: BrowserAgentCommandResult,
    error: Schema.Union([BrowserAgentCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsBrowserAgentsReloadThreadTabRpc = Rpc.make(WS_METHODS.browserAgentsReloadThreadTab, {
  payload: BrowserAgentThreadLinkInput,
  success: BrowserAgentCommandResult,
  error: Schema.Union([BrowserAgentCommandError, EnvironmentAuthorizationError]),
});

export const WsBrowserAgentsNavigateThreadTabRpc = Rpc.make(
  WS_METHODS.browserAgentsNavigateThreadTab,
  {
    payload: BrowserAgentThreadTabNavigateInput,
    success: BrowserAgentCommandResult,
    error: Schema.Union([BrowserAgentCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsBrowserAgentsInputThreadTabRpc = Rpc.make(WS_METHODS.browserAgentsInputThreadTab, {
  payload: BrowserAgentThreadTabInputCommandInput,
  success: BrowserAgentCommandResult,
  error: Schema.Union([BrowserAgentCommandError, EnvironmentAuthorizationError]),
});

export const WsBrowserAgentsSnapshotThreadTabRpc = Rpc.make(
  WS_METHODS.browserAgentsSnapshotThreadTab,
  {
    payload: BrowserAgentThreadLinkInput,
    success: BrowserAgentCommandResult,
    error: Schema.Union([BrowserAgentCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsBrowserAgentsScreenshotThreadTabRpc = Rpc.make(
  WS_METHODS.browserAgentsScreenshotThreadTab,
  {
    payload: BrowserAgentThreadLinkInput,
    success: BrowserAgentCommandResult,
    error: Schema.Union([BrowserAgentCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsBrowserAgentsRuntimeCommandRpc = Rpc.make(WS_METHODS.browserAgentsRuntimeCommand, {
  payload: BrowserAgentRuntimeCommandInput,
  success: BrowserAgentCommandResult,
  error: Schema.Union([BrowserAgentCommandError, EnvironmentAuthorizationError]),
});

export const WsOrganizationPanelGetRpc = Rpc.make(WS_METHODS.organizationPanelGet, {
  payload: OrganizationPanelGetInput,
  success: OrganizationPanelGetResult,
  error: Schema.Union([OrganizationPanelError, EnvironmentAuthorizationError]),
});

export const WsOrganizationPanelTurnStartRpc = Rpc.make(WS_METHODS.organizationPanelTurnStart, {
  payload: OrganizationPanelTurnStartInput,
  success: OrganizationPanelTurnStartResult,
  error: Schema.Union([OrganizationPanelError, EnvironmentAuthorizationError]),
});

export const WsOrganizationPanelTurnStopRpc = Rpc.make(WS_METHODS.organizationPanelTurnStop, {
  payload: OrganizationPanelTurnStopInput,
  success: OrganizationPanelTurnStopResult,
  error: Schema.Union([OrganizationPanelError, EnvironmentAuthorizationError]),
});

export const WsOrganizationPanelHistoryListRpc = Rpc.make(WS_METHODS.organizationPanelHistoryList, {
  payload: OrganizationPanelHistoryListInput,
  success: OrganizationPanelHistoryListResult,
  error: Schema.Union([OrganizationPanelError, EnvironmentAuthorizationError]),
});

export const WsOrganizationPanelRollbackRpc = Rpc.make(WS_METHODS.organizationPanelRollback, {
  payload: OrganizationPanelRollbackInput,
  success: OrganizationPanelRollbackResult,
  error: Schema.Union([OrganizationPanelError, EnvironmentAuthorizationError]),
});

export const WsOrganizationPanelDynamicRpcListRpc = Rpc.make(
  WS_METHODS.organizationPanelDynamicRpcList,
  {
    payload: OrganizationPanelDynamicRpcListInput,
    success: OrganizationPanelDynamicRpcListResult,
    error: Schema.Union([OrganizationPanelError, EnvironmentAuthorizationError]),
  },
);

export const WsOrganizationPanelDynamicRpcInvokeRpc = Rpc.make(
  WS_METHODS.organizationPanelDynamicRpcInvoke,
  {
    payload: OrganizationPanelDynamicRpcInvokeInput,
    success: OrganizationPanelDynamicRpcInvokeResult,
    error: Schema.Union([OrganizationPanelError, EnvironmentAuthorizationError]),
  },
);

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([ProjectSearchEntriesError, EnvironmentAuthorizationError]),
});

export const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: Schema.Union([ProjectReadFileError, EnvironmentAuthorizationError]),
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([ProjectWriteFileError, EnvironmentAuthorizationError]),
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: Schema.Union([ExternalLauncherError, EnvironmentAuthorizationError]),
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: Schema.Union([FilesystemBrowseError, EnvironmentAuthorizationError]),
});

export const WsWorkspaceFilesListDirectoryRpc = Rpc.make(WS_METHODS.workspaceFilesListDirectory, {
  payload: WorkspaceListDirectoryInput,
  success: WorkspaceListDirectoryResult,
  error: Schema.Union([WorkspaceFileError, EnvironmentAuthorizationError]),
});

export const WsWorkspaceFilesReadFileRpc = Rpc.make(WS_METHODS.workspaceFilesReadFile, {
  payload: WorkspaceReadFileInput,
  success: WorkspaceReadFileResult,
  error: Schema.Union([WorkspaceFileError, EnvironmentAuthorizationError]),
});

export const WsWorkspaceFilesWriteFileRpc = Rpc.make(WS_METHODS.workspaceFilesWriteFile, {
  payload: WorkspaceWriteFileInput,
  success: WorkspaceWriteFileResult,
  error: Schema.Union([WorkspaceFileError, EnvironmentAuthorizationError]),
});

export const WsWorkspaceFilesCreateFileRpc = Rpc.make(WS_METHODS.workspaceFilesCreateFile, {
  payload: WorkspaceCreateFileInput,
  success: WorkspaceMutationResult,
  error: Schema.Union([WorkspaceFileError, EnvironmentAuthorizationError]),
});

export const WsWorkspaceFilesCreateDirectoryRpc = Rpc.make(
  WS_METHODS.workspaceFilesCreateDirectory,
  {
    payload: WorkspaceCreateDirectoryInput,
    success: WorkspaceMutationResult,
    error: Schema.Union([WorkspaceFileError, EnvironmentAuthorizationError]),
  },
);

export const WsWorkspaceFilesRenameRpc = Rpc.make(WS_METHODS.workspaceFilesRename, {
  payload: WorkspaceRenameInput,
  success: WorkspaceRenameResult,
  error: Schema.Union([WorkspaceFileError, EnvironmentAuthorizationError]),
});

export const WsWorkspaceFilesDeleteRpc = Rpc.make(WS_METHODS.workspaceFilesDelete, {
  payload: WorkspaceDeleteInput,
  success: WorkspaceMutationResult,
  error: Schema.Union([WorkspaceFileError, EnvironmentAuthorizationError]),
});

export const WsWorkspaceFilesSubscribeChangesRpc = Rpc.make(
  WS_METHODS.workspaceFilesSubscribeChanges,
  {
    payload: WorkspaceWatchInput,
    success: WorkspaceFileChangeEvent,
    error: Schema.Union([WorkspaceFileError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusInput,
  success: VcsStatusStreamEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsSyncBaseRpc = Rpc.make(WS_METHODS.vcsSyncBase, {
  payload: VcsSyncBaseInput,
  success: VcsSyncBaseResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsGitMarkPullRequestReadyForReviewRpc = Rpc.make(
  WS_METHODS.gitMarkPullRequestReadyForReview,
  {
    payload: GitPullRequestRefInput,
    error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  },
);

export const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: Schema.Union([VcsError, EnvironmentAuthorizationError]),
});

/**
 * Ephemeral live diff preview for compact/mobile surfaces.
 * Not the persisted T3 Review model. Future review sessions should use
 * review.open* + review.getSnapshot.
 */
export const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

export const WsReviewListPullRequestCommentsRpc = Rpc.make(
  WS_METHODS.reviewListPullRequestComments,
  {
    payload: ReviewPullRequestCommentsInput,
    success: ReviewPullRequestCommentsResult,
    error: Schema.Union([ReviewPullRequestCommentsError, EnvironmentAuthorizationError]),
  },
);

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalDetectWebServersRpc = Rpc.make(WS_METHODS.terminalDetectWebServers, {
  payload: TerminalDetectWebServersInput,
  success: TerminalDetectWebServersResult,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: Schema.Union([OrchestrationReplayEventsError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationRpcSchemas.subscribeThread.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSubscribeBrowserAgentsRpc = Rpc.make(WS_METHODS.subscribeBrowserAgents, {
  payload: Schema.Struct({}),
  success: BrowserAgentStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeOrganizationPanelEventsRpc = Rpc.make(
  WS_METHODS.subscribeOrganizationPanelEvents,
  {
    payload: OrganizationPanelEventsSubscribeInput,
    success: OrganizationPanelEvent,
    error: EnvironmentAuthorizationError,
    stream: true,
  },
);

export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerSignalProcessRpc,
  WsServerTranscribeAudioRpc,
  WsProviderListSlashCommandsRpc,
  WsCloudGetRelayClientStatusRpc,
  WsCloudInstallRelayClientRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsBrowserAgentsListRpc,
  WsBrowserAgentsOpenOrFocusPreviewRpc,
  WsBrowserAgentsActivateAnnotationRpc,
  WsBrowserAgentsOpenOrFocusThreadTabRpc,
  WsBrowserAgentsAttachActiveTabRpc,
  WsBrowserAgentsDetachThreadTabRpc,
  WsBrowserAgentsSetThreadTabControlRpc,
  WsBrowserAgentsStartThreadTabCaptureRpc,
  WsBrowserAgentsStopThreadTabCaptureRpc,
  WsBrowserAgentsBackThreadTabRpc,
  WsBrowserAgentsForwardThreadTabRpc,
  WsBrowserAgentsReloadThreadTabRpc,
  WsBrowserAgentsNavigateThreadTabRpc,
  WsBrowserAgentsInputThreadTabRpc,
  WsBrowserAgentsSnapshotThreadTabRpc,
  WsBrowserAgentsScreenshotThreadTabRpc,
  WsBrowserAgentsRuntimeCommandRpc,
  WsOrganizationPanelGetRpc,
  WsOrganizationPanelTurnStartRpc,
  WsOrganizationPanelTurnStopRpc,
  WsOrganizationPanelHistoryListRpc,
  WsOrganizationPanelRollbackRpc,
  WsOrganizationPanelDynamicRpcListRpc,
  WsOrganizationPanelDynamicRpcInvokeRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsWriteFileRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsWorkspaceFilesListDirectoryRpc,
  WsWorkspaceFilesReadFileRpc,
  WsWorkspaceFilesWriteFileRpc,
  WsWorkspaceFilesCreateFileRpc,
  WsWorkspaceFilesCreateDirectoryRpc,
  WsWorkspaceFilesRenameRpc,
  WsWorkspaceFilesDeleteRpc,
  WsWorkspaceFilesSubscribeChangesRpc,
  WsSubscribeVcsStatusRpc,
  WsVcsPullRpc,
  WsVcsSyncBaseRpc,
  WsVcsRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsGitMarkPullRequestReadyForReviewRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsReviewGetDiffPreviewRpc,
  WsReviewListPullRequestCommentsRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsTerminalDetectWebServersRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeBrowserAgentsRpc,
  WsSubscribeOrganizationPanelEventsRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationReplayEventsRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
