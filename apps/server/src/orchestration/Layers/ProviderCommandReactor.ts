import {
  type ChatAttachment,
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThread,
  ProviderDriverKind,
  type ProjectId,
  type OrchestrationSession,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ThreadHandoff,
  type ThreadHandoffSummarySource,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { buildHandoffSummaryPrompt, describeModelSelection } from "../handoffContext.ts";
import { HANDOFF_TRANSCRIPT_MAX_CHARS } from "../../textGeneration/TextGenerationPrompts.ts";
import { HandoffCaptureError, HandoffSummaryCapture } from "../Services/HandoffSummaryCapture.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/**
 * Prepends a handoff summary to the first turn on the new provider, clamped so
 * the combined input still satisfies ProviderSendTurnInput's max length. The
 * user's own message always survives intact: the summary is what gets cut.
 */
function withHandoffContext(handoffContext: string, messageText: string): string {
  const separator = "\n\n";
  const budget =
    PROVIDER_SEND_TURN_MAX_INPUT_CHARS -
    messageText.length -
    separator.length -
    HANDOFF_CLAMP_SLACK;
  if (budget <= 0) {
    return messageText;
  }
  const context =
    handoffContext.length <= budget
      ? handoffContext
      : `${handoffContext.slice(0, budget).trimEnd()}\n[handoff context truncated]`;
  return `${context}${separator}${messageText}`;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

/** Leaves room for the truncation marker when clamping handoff context. */
const HANDOFF_CLAMP_SLACK = 64;
/** A summary turn that has not settled by now is not going to. */
const HANDOFF_SUMMARY_TIMEOUT = Duration.seconds(120);
const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const DEFAULT_THREAD_TITLE = "New thread";
const MAX_REGENERATION_ATTACHMENTS = 4;
const MAX_THREAD_TITLE_CONTEXT_CHARS = 8_000;
const THREAD_TITLE_CONTEXT_TRUNCATION_MARKER = "[Earlier content truncated]\n\n";

function formatThreadTitleContext(
  messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }>,
): {
  readonly message: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
} {
  let context = "";
  let truncated = false;
  const retainedAttachments: Array<ChatAttachment> = [];

  for (const message of messages.toReversed()) {
    if (message.role === "system") {
      continue;
    }
    const text = message.text.trim();
    const attachmentSummary = (message.attachments ?? [])
      .map((attachment) => attachment.name)
      .join(", ");
    const contents = [
      ...(text.length > 0 ? [text] : []),
      ...(attachmentSummary.length > 0 ? [`[Attachments: ${attachmentSummary}]`] : []),
    ].join("\n");
    if (contents.length === 0) {
      continue;
    }

    const section = `${message.role.toUpperCase()}:\n${contents}`;
    const separator = context.length > 0 ? "\n\n" : "";
    const available = MAX_THREAD_TITLE_CONTEXT_CHARS - context.length - separator.length;
    if (section.length > available) {
      if (available > 0) {
        context = `${section.slice(-available)}${separator}${context}`;
        retainedAttachments.unshift(...(message.attachments ?? []));
      }
      truncated = true;
      break;
    }
    context = `${section}${separator}${context}`;
    retainedAttachments.unshift(...(message.attachments ?? []));
  }

  return {
    message: truncated ? `${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${context}` : context,
    attachments: retainedAttachments.slice(-MAX_REGENERATION_ATTACHMENTS),
  };
}

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const handoffSummaryCapture = yield* HandoffSummaryCapture;
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    const providerError = isProviderAdapterRequestError(failReason?.error)
      ? failReason.error
      : undefined;
    if (providerError) {
      return providerError.detail;
    }
    return Cause.pretty(cause);
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    });
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: activeSession?.provider ?? preferredProvider,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
    }
    if (thread.session !== null) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      });
    }
    if (
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    ) {
      if (currentInfo.driverKind !== desiredInfo.driverKind) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
        });
      }
      if (
        currentInfo.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        });
      }
    }
    const project = yield* resolveProject(thread.projectId);
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      providerService.startSession(threadId, {
        threadId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        providerInstanceId: desiredInstanceId,
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        modelSelection: desiredModelSelection,
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: desiredRuntimeMode,
      });

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        return existingSessionThreadId;
      }

      const resumeCursor = shouldRestartForModelChange
        ? undefined
        : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    /** Handoff summary to prepend to the provider input only. The persisted
        user message keeps the text the user actually typed. */
    readonly handoffContext?: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      pendingTurnStart: true,
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(
      input.handoffContext !== undefined
        ? withHandoffContext(input.handoffContext, input.messageText)
        : input.messageText,
    );
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const settings = yield* serverSettingsService.getSettings;
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : resolveSourceControlWriterModelSelection(
              settings,
              yield* providerRegistry.getProviders,
            );

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } =
          yield* serverSettingsService.getSettings;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: input.cwd,
          message: input.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          modelSelection,
        });
        if (!generated) return;

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    const { message, attachments } = formatThreadTitleContext(thread.messages);
    if (message.length === 0) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;
    if (thread.title !== previousTitle) {
      return { _tag: "Superseded" } as const;
    }
    const project = yield* resolveProject(thread.projectId);
    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } =
      yield* serverSettingsService.getSettings;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (generated.title === DEFAULT_THREAD_TITLE || generated.title === previousTitle) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const latestThread = yield* resolveThread(event.payload.threadId);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return { _tag: "Superseded" } as const;
    }

    return { _tag: "Completed", title: generated.title } as const;
  });
  const dispatchThreadTitleRegenerationCompletion = Effect.fn(
    "dispatchThreadTitleRegenerationCompletion",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: yield* serverCommandId("thread-title-regeneration-complete"),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  });
  const findInterruptedThreadTitleRegenerations = Effect.fn(
    "findInterruptedThreadTitleRegenerations",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return readModel.threads.flatMap((thread) => {
      const requestId = thread.titleRegeneration?.requestId;
      return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
    });
  });
  const clearInterruptedThreadTitleRegenerations = Effect.fn(
    "clearInterruptedThreadTitleRegenerations",
  )(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) => {
        return dispatchThreadTitleRegenerationCompletion({
          threadId,
          requestId,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to clear interrupted title regeneration",
              {
                threadId,
                cause: Cause.pretty(cause),
              },
            );
          }),
        );
      },
      { discard: true },
    );
  });
  const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
      if (requestId === null) {
        return;
      }
      const result = yield* regenerateThreadTitle(event, requestId).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("provider command reactor failed to regenerate thread title", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ _tag: "Completed", title: undefined } as const));
        }),
      );
      if (result._tag === "Superseded") {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };
      yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor retrying title regeneration completion",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          ).pipe(Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion)));
        }),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor failed to complete title regeneration",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          );
        }),
      ),
  );
  const threadTitleRegenerationWorker = yield* makeDrainableWorker(
    processThreadTitleRegenerationSafely,
  );

  const dispatchHandoffCompletion = Effect.fn("dispatchHandoffCompletion")(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly outcome: "completed" | "failed";
    readonly summary?: string;
    readonly summarySource?: ThreadHandoffSummarySource;
    readonly detail?: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.handoff.complete",
      commandId: yield* serverCommandId("thread-handoff-complete"),
      threadId: input.threadId,
      requestId: input.requestId,
      outcome: input.outcome,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.summarySource !== undefined ? { summarySource: input.summarySource } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      createdAt: yield* nowIso,
    });
  });

  const appendHandoffActivity = Effect.fn("appendHandoffActivity")(function* (input: {
    readonly threadId: ThreadId;
    readonly handoff: ThreadHandoff;
    readonly summary?: string;
    readonly summarySource?: ThreadHandoffSummarySource;
    readonly detail?: string;
    readonly failed: boolean;
    readonly createdAt: string;
  }) {
    const fromLabel = describeModelSelection(input.handoff.fromModelSelection);
    const toLabel = describeModelSelection(input.handoff.toModelSelection);
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("thread-handoff-activity"),
      threadId: input.threadId,
      activity: {
        id: yield* serverEventId(),
        tone: input.failed ? "error" : "info",
        kind: input.failed ? "provider-handoff.failed" : "provider-handoff",
        summary: input.failed
          ? `Handoff to ${toLabel} failed`
          : `Handed off from ${fromLabel} to ${toLabel}`,
        payload: {
          fromModelSelection: input.handoff.fromModelSelection,
          toModelSelection: input.handoff.toModelSelection,
          fromLabel,
          toLabel,
          ...(input.summary !== undefined ? { summaryMarkdown: input.summary } : {}),
          ...(input.summarySource !== undefined ? { summarySource: input.summarySource } : {}),
          ...(input.detail !== undefined ? { detail: input.detail } : {}),
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  /**
   * Flattens a thread into a transcript for the fallback summarizer. Retains
   * the newest content, which is where the live task state lives.
   */
  const formatHandoffTranscript = (thread: OrchestrationThread): string => {
    const sections: Array<string> = [];
    let used = 0;
    let truncated = false;
    for (const message of thread.messages.toReversed()) {
      const text = message.text.trim();
      if (text.length === 0) continue;
      const section = `${message.role.toUpperCase()}:\n${text}`;
      if (used + section.length > HANDOFF_TRANSCRIPT_MAX_CHARS) {
        truncated = true;
        break;
      }
      used += section.length;
      sections.unshift(section);
    }
    // Activity summaries are one-liners; they add the tool/file trail the
    // message text alone does not show.
    const activityTrail = thread.activities
      .slice(-80)
      .map((activity) => `- ${activity.kind}: ${activity.summary}`)
      .join("\n");
    return [
      ...(truncated ? ["[Earlier conversation truncated]"] : []),
      ...sections,
      ...(activityTrail.length > 0 ? ["", "ACTIVITY TRAIL:", activityTrail] : []),
    ].join("\n\n");
  };

  const captureHandoffSummaryFromLiveSession = Effect.fn("captureHandoffSummaryFromLiveSession")(
    function* (input: { readonly threadId: ThreadId; readonly handoff: ThreadHandoff }) {
      yield* handoffSummaryCapture.begin(input.threadId);
      const captured = yield* Effect.gen(function* () {
        yield* providerService.sendTurn({
          threadId: input.threadId,
          input: buildHandoffSummaryPrompt({
            from: input.handoff.fromModelSelection,
            to: input.handoff.toModelSelection,
          }),
        });
        return yield* handoffSummaryCapture.await(input.threadId);
      }).pipe(
        Effect.timeoutOption(HANDOFF_SUMMARY_TIMEOUT),
        // The summary turn may still be running when we give up on it; leaving
        // it live would race the session stop that follows.
        Effect.onError(() =>
          providerService
            .interruptTurn({ threadId: input.threadId })
            .pipe(Effect.ignoreCause({ log: true })),
        ),
        Effect.ensuring(handoffSummaryCapture.end(input.threadId)),
      );
      if (Option.isNone(captured)) {
        return yield* new HandoffCaptureError({
          threadId: input.threadId,
          reason: "turn-failed",
          detail: "The summary turn did not finish in time.",
        });
      }
      return captured.value;
    },
  );

  const generateHandoffSummaryFromTranscript = Effect.fn("generateHandoffSummaryFromTranscript")(
    function* (input: { readonly thread: OrchestrationThread; readonly handoff: ThreadHandoff }) {
      const settings = yield* serverSettingsService.getSettings;
      const project = yield* resolveProject(input.thread.projectId);
      const cwd =
        resolveThreadWorkspaceCwd({
          thread: input.thread,
          projects: project ? [project] : [],
        }) ?? process.cwd();
      const generated = yield* textGeneration.generateHandoffSummary({
        cwd,
        transcript: formatHandoffTranscript(input.thread),
        fromLabel: describeModelSelection(input.handoff.fromModelSelection),
        toLabel: describeModelSelection(input.handoff.toModelSelection),
        modelSelection: settings.textGenerationModelSelection,
      });
      return generated.summary;
    },
  );

  const processHandoffRequested = Effect.fn("processHandoffRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
  ) {
    const handoff = event.payload.handoff;
    if (handoff == null) {
      return;
    }
    const thread = yield* resolveThread(event.payload.threadId);
    // A newer handoff (or a completion that already landed) owns the thread now.
    if (!thread || thread.handoff?.requestId !== handoff.requestId) {
      return;
    }
    // The decider checks this too, but a turn can start between decide and
    // here. Summarizing mid-turn would capture half-finished state.
    if (thread.session?.status === "running" || thread.session?.activeTurnId != null) {
      yield* appendHandoffActivity({
        threadId: thread.id,
        handoff,
        detail: "A turn started while the handoff was being prepared.",
        failed: true,
        createdAt: event.occurredAt,
      });
      yield* dispatchHandoffCompletion({
        threadId: thread.id,
        requestId: handoff.requestId,
        outcome: "failed",
        detail: "A turn started while the handoff was being prepared.",
      });
      return;
    }

    const hasLiveSession =
      thread.session != null &&
      thread.session.status !== "stopped" &&
      thread.session.status !== "error";

    type HandoffSummaryResult = {
      readonly summary: string;
      readonly source: ThreadHandoffSummarySource;
    };

    // Preferred path: the outgoing session still holds context the stored
    // transcript cannot show — full tool output, file contents it read.
    const liveSummary: Option.Option<string> = hasLiveSession
      ? yield* captureHandoffSummaryFromLiveSession({
          threadId: thread.id,
          handoff,
        }).pipe(
          Effect.map((summary): Option.Option<string> => Option.some(summary)),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning(
                  "provider command reactor could not capture a handoff summary from the live session",
                  { threadId: thread.id, cause: Cause.pretty(cause) },
                ).pipe(Effect.as(Option.none<string>())),
          ),
        )
      : Option.none<string>();

    const summaryResult: Option.Option<HandoffSummaryResult> = Option.isSome(liveSummary)
      ? Option.some({ summary: liveSummary.value, source: "live-session" })
      : yield* generateHandoffSummaryFromTranscript({ thread, handoff }).pipe(
          Effect.map(
            (summary): Option.Option<HandoffSummaryResult> =>
              Option.some({ summary, source: "transcript" }),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning(
                  "provider command reactor could not generate a handoff summary from the transcript",
                  { threadId: thread.id, cause: Cause.pretty(cause) },
                ).pipe(Effect.as(Option.none<HandoffSummaryResult>())),
          ),
        );

    // Both summarizers failed. Do NOT switch: the user keeps a working session
    // instead of a new provider with no memory of the conversation.
    if (Option.isNone(summaryResult) || summaryResult.value.summary.trim().length === 0) {
      const detail =
        "Could not summarize the conversation for handoff. The provider was not changed.";
      yield* appendHandoffActivity({
        threadId: thread.id,
        handoff,
        detail,
        failed: true,
        createdAt: event.occurredAt,
      });
      yield* dispatchHandoffCompletion({
        threadId: thread.id,
        requestId: handoff.requestId,
        outcome: "failed",
        detail,
      });
      return;
    }

    const summary = summaryResult.value.summary.trim();
    yield* appendHandoffActivity({
      threadId: thread.id,
      handoff,
      summary,
      summarySource: summaryResult.value.source,
      failed: false,
      createdAt: event.occurredAt,
    });

    // The old session's resume state is driver-specific and useless to the
    // incoming provider, so it is torn down rather than carried over.
    const now = yield* nowIso;
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService
        .stopSession({ threadId: thread.id })
        .pipe(Effect.ignoreCause({ log: true }));
      yield* setThreadSession({
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "stopped",
          providerName: thread.session.providerName,
          ...(thread.session.providerInstanceId !== undefined
            ? { providerInstanceId: thread.session.providerInstanceId }
            : {}),
          runtimeMode: thread.session.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
    }

    // Keep the restart heuristics from replaying the outgoing provider's
    // selection on the next turn.
    threadModelSelections.set(thread.id, handoff.toModelSelection);

    yield* dispatchHandoffCompletion({
      threadId: thread.id,
      requestId: handoff.requestId,
      outcome: "completed",
      summary,
      summarySource: summaryResult.value.source,
    });
  });

  const processHandoffRequestedSafely = Effect.fn("processHandoffRequestedSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      yield* processHandoffRequested(event);
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          const requestId = event.payload.handoff?.requestId;
          return Effect.logWarning("provider command reactor failed to process handoff", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }).pipe(
            // Without this the thread would stay wedged in "handing off"
            // forever, with its composer disabled.
            Effect.andThen(
              requestId === undefined
                ? Effect.void
                : dispatchHandoffCompletion({
                    threadId: event.payload.threadId,
                    requestId,
                    outcome: "failed",
                    detail: "The handoff failed unexpectedly. The provider was not changed.",
                  }).pipe(Effect.ignoreCause({ log: true })),
            ),
          );
        }),
      ),
  );

  const handoffWorker = yield* makeDrainableWorker(processHandoffRequestedSafely);

  const findInterruptedThreadHandoffs = Effect.fn("findInterruptedThreadHandoffs")(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return readModel.threads.flatMap((thread) => {
      const requestId = thread.handoff?.requestId;
      return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
    });
  });

  const clearInterruptedThreadHandoffs = Effect.fn("clearInterruptedThreadHandoffs")(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) =>
        dispatchHandoffCompletion({
          threadId,
          requestId,
          outcome: "failed",
          detail: "The server restarted during the handoff. The provider was not changed.",
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("provider command reactor failed to clear interrupted handoff", {
                  threadId,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { discard: true },
    );
  });

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const isFirstUserMessageTurn =
      thread.messages.filter((entry) => entry.role === "user").length === 1;
    if (isFirstUserMessageTurn) {
      const project = yield* resolveProject(thread.projectId);
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: project ? [project] : [],
        }) ?? process.cwd();
      const generationInput = {
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      return setThreadSessionErrorOnTurnStartFailure({
        threadId: event.payload.threadId,
        detail,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.flatMap(() =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail,
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      ...(event.payload.handoffContext !== undefined
        ? { handoffContext: event.payload.handoffContext }
        : {}),
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      return;
    }

    yield* providerService
      .sendTurn(sendTurnRequest.value)
      .pipe(Effect.catchCause(recoverTurnStartFailure), Effect.forkScoped);
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService.interruptTurn({ threadId: event.payload.threadId });
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId: thread.id });
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.meta-updated":
        // Separate workers: a handoff runs a provider turn and can take a
        // couple of minutes, and must not block title regeneration.
        if (event.payload.handoff != null) {
          yield* handoffWorker.enqueue(event);
          return;
        }
        yield* threadTitleRegenerationWorker.enqueue(event);
        return;
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const interruptedTitleRegenerations = yield* findInterruptedThreadTitleRegenerations().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to find interrupted title regenerations",
          { cause: Cause.pretty(cause) },
        ).pipe(Effect.as([]));
      }),
    );
    const interruptedHandoffs = yield* findInterruptedThreadHandoffs().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to find interrupted handoffs", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([]));
      }),
    );
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        (event.type === "thread.meta-updated" &&
          (event.payload.regenerateTitle === true || event.payload.handoff != null)) ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    yield* forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent));

    // The domain event stream is hot, so work pending before this reactor
    // starts cannot be resumed. Correlated completions only clear the request
    // captured here, leaving any newer request untouched.
    const clearInterrupted = Effect.andThen(
      clearInterruptedThreadTitleRegenerations(interruptedTitleRegenerations),
      clearInterruptedThreadHandoffs(interruptedHandoffs),
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to clear interrupted title regenerations",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* clearInterrupted;
    } else {
      yield* forkParked(clearInterrupted);
    }
  });

  return {
    start,
    drain: Effect.gen(function* () {
      yield* worker.drain;
      yield* threadTitleRegenerationWorker.drain;
      yield* handoffWorker.drain;
    }),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
