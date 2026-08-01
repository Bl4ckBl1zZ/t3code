import { create } from "zustand";

import type {
  MessageId,
  ModelSelection,
  PreviewAnnotationPayload,
  ProviderDriverKind,
  ServerProvider,
} from "@t3tools/contracts";

import type { ComposerImageAttachment } from "./composerDraftStore";
import type { ElementContextDraft } from "./lib/elementContext";
import type { TerminalContextDraft } from "./lib/terminalContext";
import type { ReviewCommentContext } from "./reviewCommentContext";

/**
 * Hard cap per thread. Queueing is a short-term buffer while a turn runs, not
 * a task planner; an unbounded queue silently accumulating stale instructions
 * is worse UX than asking the user to wait.
 */
export const MAX_QUEUED_MESSAGES_PER_THREAD = 10;

/**
 * A message captured from the composer while the agent was busy. Everything
 * needed to dispatch later is snapshotted at enqueue time — including the
 * model/provider selection — so changing the composer's model afterwards
 * never rewrites what an already-queued message will send with.
 *
 * The queue is deliberately in-memory only: image attachments hold live
 * `File`/blob-URL handles that don't survive a reload, and a queued message
 * is seconds-to-minutes old by design. On reload the queue is gone; the
 * mobile app's persistent outbox covers the offline/long-lived case.
 */
export interface QueuedComposerMessage {
  readonly id: MessageId;
  readonly createdAt: string;
  readonly prompt: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly elementContexts: ReadonlyArray<ElementContextDraft>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly modelSelection: ModelSelection;
  readonly provider: ProviderDriverKind;
  readonly model: string;
  readonly providerModels: ReadonlyArray<ServerProvider["models"][number]>;
  readonly promptEffort: string | null;
  /** Set when the last dispatch attempt failed; cleared on edit/retry. */
  readonly lastDispatchError: string | null;
}

interface QueuedMessageStoreState {
  queuesByThreadKey: Record<string, ReadonlyArray<QueuedComposerMessage>>;
  /** Message currently being dispatched by the drain; its row locks. */
  dispatchingMessageId: MessageId | null;
  /**
   * Messages open in an inline editor. The drain must not dispatch one of
   * these — the queued payload is stale until the edit is saved or cancelled.
   */
  editingMessageIds: Readonly<Record<MessageId, true>>;
  enqueue: (threadKey: string, message: QueuedComposerMessage) => boolean;
  remove: (threadKey: string, messageId: MessageId) => QueuedComposerMessage | null;
  move: (threadKey: string, messageId: MessageId, direction: "up" | "down") => void;
  updatePrompt: (threadKey: string, messageId: MessageId, prompt: string) => void;
  holdEditing: (messageId: MessageId) => void;
  releaseEditing: (messageId: MessageId) => void;
  setDispatching: (messageId: MessageId | null) => void;
  setDispatchError: (threadKey: string, messageId: MessageId, error: string | null) => void;
  clearThread: (threadKey: string) => void;
}

function revokeQueuedMessagePreviewUrls(message: QueuedComposerMessage): void {
  if (typeof URL === "undefined") {
    return;
  }
  for (const image of message.images) {
    if (image.previewUrl.startsWith("blob:")) {
      URL.revokeObjectURL(image.previewUrl);
    }
  }
}

export const useQueuedMessageStore = create<QueuedMessageStoreState>()((set, get) => ({
  queuesByThreadKey: {},
  dispatchingMessageId: null,
  editingMessageIds: {},
  enqueue: (threadKey, message) => {
    const queue = get().queuesByThreadKey[threadKey] ?? [];
    if (queue.length >= MAX_QUEUED_MESSAGES_PER_THREAD) {
      return false;
    }
    set((state) => ({
      queuesByThreadKey: {
        ...state.queuesByThreadKey,
        [threadKey]: [...(state.queuesByThreadKey[threadKey] ?? []), message],
      },
    }));
    return true;
  },
  remove: (threadKey, messageId) => {
    const queue = get().queuesByThreadKey[threadKey] ?? [];
    const removed = queue.find((message) => message.id === messageId) ?? null;
    if (!removed) {
      return null;
    }
    set((state) => {
      const next = { ...state.queuesByThreadKey };
      const remaining = (next[threadKey] ?? []).filter((message) => message.id !== messageId);
      if (remaining.length === 0) {
        delete next[threadKey];
      } else {
        next[threadKey] = remaining;
      }
      const editing = state.editingMessageIds[messageId]
        ? (() => {
            const nextEditing = { ...state.editingMessageIds };
            delete nextEditing[messageId];
            return nextEditing;
          })()
        : state.editingMessageIds;
      return { queuesByThreadKey: next, editingMessageIds: editing };
    });
    return removed;
  },
  move: (threadKey, messageId, direction) => {
    set((state) => {
      const queue = state.queuesByThreadKey[threadKey] ?? [];
      const index = queue.findIndex((message) => message.id === messageId);
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (index === -1 || targetIndex < 0 || targetIndex >= queue.length) {
        return state;
      }
      const next = [...queue];
      const [entry] = next.splice(index, 1);
      next.splice(targetIndex, 0, entry!);
      return {
        queuesByThreadKey: { ...state.queuesByThreadKey, [threadKey]: next },
      };
    });
  },
  updatePrompt: (threadKey, messageId, prompt) => {
    set((state) => {
      const queue = state.queuesByThreadKey[threadKey];
      if (!queue?.some((message) => message.id === messageId)) {
        return state;
      }
      return {
        queuesByThreadKey: {
          ...state.queuesByThreadKey,
          [threadKey]: queue.map((message) =>
            message.id === messageId ? { ...message, prompt, lastDispatchError: null } : message,
          ),
        },
      };
    });
  },
  holdEditing: (messageId) => {
    set((state) =>
      state.editingMessageIds[messageId]
        ? state
        : { editingMessageIds: { ...state.editingMessageIds, [messageId]: true } },
    );
  },
  releaseEditing: (messageId) => {
    set((state) => {
      if (!state.editingMessageIds[messageId]) {
        return state;
      }
      const next = { ...state.editingMessageIds };
      delete next[messageId];
      return { editingMessageIds: next };
    });
  },
  setDispatching: (messageId) => {
    set({ dispatchingMessageId: messageId });
  },
  setDispatchError: (threadKey, messageId, error) => {
    set((state) => {
      const queue = state.queuesByThreadKey[threadKey];
      if (!queue?.some((message) => message.id === messageId)) {
        return state;
      }
      return {
        queuesByThreadKey: {
          ...state.queuesByThreadKey,
          [threadKey]: queue.map((message) =>
            message.id === messageId ? { ...message, lastDispatchError: error } : message,
          ),
        },
      };
    });
  },
  clearThread: (threadKey) => {
    const queue = get().queuesByThreadKey[threadKey] ?? [];
    for (const message of queue) {
      revokeQueuedMessagePreviewUrls(message);
    }
    set((state) => {
      if (!(threadKey in state.queuesByThreadKey)) {
        return state;
      }
      const next = { ...state.queuesByThreadKey };
      delete next[threadKey];
      return { queuesByThreadKey: next };
    });
  },
}));

/** Revoke a removed message's blob previews once nothing can restore it. */
export function disposeQueuedComposerMessage(message: QueuedComposerMessage): void {
  revokeQueuedMessagePreviewUrls(message);
}
