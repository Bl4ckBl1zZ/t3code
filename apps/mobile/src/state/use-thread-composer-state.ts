import { useAtomValue } from "@effect/atom-react";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import {
  deriveThreadActivityRun,
  deriveThreadRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import { useCallback, useEffect, useMemo } from "react";

import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerImages,
} from "../lib/composerImages";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { pickComposerDocuments } from "../lib/composerDocuments";
import { resolveHermesChatCommand } from "../lib/hermesChatCommands";
import { buildProviderDriverMap, isHermesThread } from "../lib/mobileWorkspace";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildThreadFeed } from "../lib/threadActivity";
import { appAtomRegistry } from "../state/atom-registry";
import { useAtomCommand } from "./use-atom-command";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraftContent,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeComposerDraftAttachment,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
} from "./use-composer-drafts";
import { setPendingConnectionError } from "../state/use-remote-environment-registry";
import {
  useSelectedThreadProjection,
  useSelectedThreadVisibleTurnItems,
} from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import {
  enqueueThreadOutboxMessage,
  removeThreadOutboxMessage,
  updateThreadOutboxMessage,
} from "./thread-outbox";
import type { QueuedThreadMessage } from "./thread-outbox";
import {
  holdEditingQueuedMessage,
  releaseEditingQueuedMessage,
  useThreadOutboxMessages,
} from "./use-thread-outbox";
import { dispatchingQueuedMessageIdAtom } from "./use-thread-outbox-drain";

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const existing = appAtomRegistry.get(composerDraftsAtom)[threadKey]?.text ?? "";
  const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
  setComposerDraftText(threadKey, `${existing}${separator}${input.text}`);
  if (input.attachments && input.attachments.length > 0) {
    appendComposerDraftAttachments(threadKey, input.attachments);
  }
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
}

export function useThreadComposerState(options?: {
  /**
   * Invoked when the composer intercepts /new or /reset. The route screen
   * wires this to its new-conversation flow, which owns navigation.
   */
  readonly onRequestFreshHermesChat?: () => void;
}) {
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const selectedThreadProjection = useSelectedThreadProjection();
  const selectedThreadVisibleTurnItems = useSelectedThreadVisibleTurnItems();
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  const selectedThreadFeed = useMemo(
    () => buildThreadFeed(selectedThreadVisibleTurnItems),
    [selectedThreadVisibleTurnItems],
  );
  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null;
  const draftMessage = selectedDraft?.text ?? "";
  const draftAttachments = selectedDraft?.attachments ?? [];
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThread = selectedThreadShell;
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const runtimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const interactionMode = selectedDraft?.interactionMode ?? selectedThread?.interactionMode ?? null;
  const selectedThreadRuntime = useMemo(
    () =>
      selectedThreadProjection
        ? deriveThreadRuntime(selectedThreadProjection.projection)
        : (selectedThreadShell?.runtime ?? null),
    [selectedThreadProjection, selectedThreadShell?.runtime],
  );
  const selectedThreadActivityRun = useMemo(
    () =>
      selectedThreadProjection
        ? deriveThreadActivityRun(selectedThreadProjection.projection)
        : (selectedThreadShell?.latestRun ?? null),
    [selectedThreadProjection, selectedThreadShell?.latestRun],
  );

  const selectedThreadSessionActivity = useMemo(() => {
    if (!selectedThreadRuntime) {
      return null;
    }

    return {
      orchestrationStatus: selectedThreadRuntime.status,
      activeRunId: selectedThreadRuntime.activeRunId ?? undefined,
    };
  }, [selectedThreadRuntime]);

  const activeWorkStartedAt = useMemo(() => {
    if (!selectedThreadShell) {
      return null;
    }
    return deriveActiveWorkStartedAt(
      selectedThreadActivityRun,
      selectedThreadSessionActivity,
      null,
    );
  }, [selectedThreadActivityRun, selectedThreadSessionActivity, selectedThreadShell]);

  const activeThreadBusy = threadRuntimeIsActive(selectedThreadRuntime);
  const interruptibleRunId = selectedThreadRuntime?.activeRunId ?? null;

  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const providerDrivers = useMemo(() => buildProviderDriverMap(serverConfigs), [serverConfigs]);

  const onSendMessage = useCallback(async () => {
    if (!selectedThreadShell) {
      return null;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const draft = getComposerDraftSnapshot(threadKey);
    const thread = selectedThreadShell;
    const text = draft.text.trim();
    const attachments = draft.attachments;
    if (text.length === 0 && attachments.length === 0) {
      return null;
    }

    // T3 Work handles a few slash commands locally rather than sending them to
    // Hermes: /new and /reset start a fresh-context conversation, /clear wipes
    // the visible timeline. Attachments make it a real message, not a command.
    if (attachments.length === 0) {
      const command = resolveHermesChatCommand({
        text,
        isHermesConversation: isHermesThread(thread, providerDrivers),
      });
      if (command === "clear-timeline") {
        clearComposerDraftContent(threadKey);
        const cleared = await updateThreadMetadata({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, clearTimeline: true },
        });
        if (cleared._tag === "Failure") {
          // Put the command back so the user can retry rather than losing it.
          void mergeComposerDraftContent(threadKey, { text, attachments: [] });
          setPendingConnectionError("Failed to clear the conversation.");
        }
        return null;
      }
      if (command === "fresh-chat") {
        clearComposerDraftContent(threadKey);
        options?.onRequestFreshHermesChat?.();
        return null;
      }
    }

    const metadata = makeQueuedMessageMetadata();
    const messageId = MessageId.make(metadata.messageId);
    // Enqueue publishes the queued atom synchronously (the durable write
    // happens behind it), so clearing the draft here gives send feedback on
    // the tap frame instead of after file I/O. If the write fails the message
    // is rolled out of the queue and the content is merged back into the
    // draft, preserving anything typed since.
    const enqueuePromise = enqueueThreadOutboxMessage({
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
      messageId,
      commandId: CommandId.make(metadata.commandId),
      text,
      attachments,
      modelSelection: draft.modelSelection ?? thread.modelSelection,
      runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
      interactionMode: draft.interactionMode ?? thread.interactionMode,
      createdAt: metadata.createdAt,
    });
    clearComposerDraftContent(threadKey);
    enqueuePromise.catch((error: unknown) => {
      // Restore text via merge (idempotent) but attachments via the uncapped
      // append: the merge path slots existing attachments first and truncates
      // at the send limit, which would silently drop this message's images if
      // the user attached new ones while the write was in flight.
      void mergeComposerDraftContent(threadKey, { text, attachments: [] });
      appendComposerDraftAttachments(threadKey, attachments);
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to save the queued message.",
      );
    });
    return messageId;
  }, [options, providerDrivers, selectedThreadShell, updateThreadMetadata]);

  const onDeleteQueuedMessage = useCallback((message: QueuedThreadMessage) => {
    removeThreadOutboxMessage(message).catch((error: unknown) => {
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to delete the queued message.",
      );
    });
  }, []);

  // The outbox orders by createdAt, so moving a message swaps timestamps with
  // its neighbor — the order change persists through restart for free.
  const onMoveQueuedMessage = useCallback(
    (message: QueuedThreadMessage, direction: "up" | "down") => {
      const index = selectedThreadQueuedMessages.findIndex(
        (candidate) => candidate.messageId === message.messageId,
      );
      const neighborIndex = direction === "up" ? index - 1 : index + 1;
      const neighbor = selectedThreadQueuedMessages[neighborIndex];
      if (index === -1 || !neighbor) {
        return;
      }
      // The two writes are not atomic: if the second fails after the first
      // succeeded, both messages would share a createdAt and their order after
      // reload would depend on storage enumeration. Sequence them and restore
      // the first message on a second-write failure.
      void (async () => {
        await updateThreadOutboxMessage({ ...message, createdAt: neighbor.createdAt });
        try {
          await updateThreadOutboxMessage({ ...neighbor, createdAt: message.createdAt });
        } catch (error) {
          await updateThreadOutboxMessage(message).catch(() => undefined);
          throw error;
        }
      })().catch((error: unknown) => {
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to reorder the queued messages.",
        );
      });
    },
    [selectedThreadQueuedMessages],
  );

  const onUpdateQueuedMessageText = useCallback((message: QueuedThreadMessage, text: string) => {
    updateThreadOutboxMessage({ ...message, text }).catch((error: unknown) => {
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to update the queued message.",
      );
    });
  }, []);

  const onQueuedMessageEditingChange = useCallback(
    (message: QueuedThreadMessage, editing: boolean) => {
      if (editing) {
        holdEditingQueuedMessage(message.messageId);
      } else {
        releaseEditingQueuedMessage(message.messageId);
      }
    },
    [],
  );

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      setComposerDraftText(threadKey, value);
    },
    [selectedThreadShell],
  );

  const onPickDraftImages = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pickComposerImages({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onPickDraftDocuments = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pickComposerDocuments({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.documents.length > 0) {
      appendComposerDraftAttachments(threadKey, result.documents);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  // Attachments produced in-app (camera captures) rather than through a
  // system picker: already validated, so they append directly.
  const onAddDraftAttachments = useCallback(
    (attachments: ReadonlyArray<DraftComposerAttachment>) => {
      if (!selectedThreadShell || attachments.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      appendComposerDraftAttachments(threadKey, attachments);
    },
    [selectedThreadShell],
  );

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(threadKey, images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", {
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        });
      }
    },
    [composerDrafts, selectedThreadShell],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      removeComposerDraftAttachment(threadKey, imageId);
    },
    [selectedThreadShell],
  );

  const onUpdateModelSelection = useCallback(
    (value: ModelSelection) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { modelSelection: value });
    },
    [selectedThreadKey],
  );

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { runtimeMode: value });
    },
    [selectedThreadKey],
  );

  const onUpdateInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { interactionMode: value });
    },
    [selectedThreadKey],
  );

  return {
    selectedThreadFeed,
    selectedThreadActivityRun,
    selectedThreadQueueCount,
    selectedThreadQueuedMessages,
    dispatchingQueuedMessageId,
    onDeleteQueuedMessage,
    onMoveQueuedMessage,
    onUpdateQueuedMessageText,
    onQueuedMessageEditingChange,
    activeWorkStartedAt,
    draftMessage,
    draftAttachments,
    modelSelection,
    runtimeMode,
    interactionMode,
    activeThreadBusy,
    interruptibleRunId,
    onChangeDraftMessage,
    onPickDraftImages,
    onPickDraftDocuments,
    onAddDraftAttachments,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
  };
}
