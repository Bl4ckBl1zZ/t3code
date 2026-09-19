import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useThreadShells } from "../state/entities";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  unlockNotificationAudio,
} from "../threadNotifications";
import {
  resolveThreadNotificationEvents,
  threadNotificationKey,
  type ThreadNotificationMemory,
} from "./ThreadNotificationCoordinator.logic";
import { toastManager } from "./ui/toast";

/**
 * Opt-in alerts for threads that finish, fail, or start waiting on the user: a sound, an in-app
 * toast while the app is focused on another thread, and a system notification plus dock/favicon
 * badge while it is not. Renders nothing and stays idle while every channel is off.
 */
export function ThreadNotificationCoordinator() {
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  if (mode === "off" && !inAppNotificationsEnabled) return null;
  return <ThreadNotifications />;
}

function ThreadNotifications() {
  const threads = useThreadShells();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const previous = useRef<ReadonlyMap<string, ThreadNotificationMemory>>(new Map());
  const pending = useRef(new Map<string, Notification>());

  const clearPending = useCallback(() => {
    for (const notification of pending.current.values()) notification.close();
    pending.current.clear();
    setNotificationBadge(0);
  }, []);

  useEffect(() => {
    clearPending();
    if (!hasDesktopNotifications(mode)) return;
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clearPending);
    window.addEventListener("focus", clearPending);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clearPending);
      clearPending();
    };
  }, [clearPending, mode]);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  useEffect(() => {
    const { next, events } = resolveThreadNotificationEvents(previous.current, threads);
    previous.current = next;

    // Threads that left (deleted, or their environment disconnected) take their alert with them.
    let pendingChanged = false;
    for (const [key, notification] of pending.current) {
      if (next.has(key)) continue;
      notification.close();
      pending.current.delete(key);
      pendingChanged = true;
    }
    if (pendingChanged) setNotificationBadge(pending.current.size);

    for (const { thread, kind, tone, title } of events) {
      const openThread = () =>
        navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: thread.environmentId, threadId: thread.id },
        });
      if (hasNotificationSound(mode)) {
        void playNotificationSound(kind, () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
      const focused = document.visibilityState === "visible" && document.hasFocus();
      if (focused) {
        if (
          !inAppNotificationsEnabled ||
          (activeEnvironmentId === thread.environmentId && activeThreadId === thread.id)
        ) {
          continue;
        }
        const toastId = toastManager.add({
          type: tone,
          title,
          description: thread.title,
          data: { hideCopyButton: true },
          actionProps: {
            children: "Open thread",
            onClick: () => {
              toastManager.close(toastId);
              void openThread();
            },
          },
        });
        continue;
      }
      if (
        !hasDesktopNotifications(mode) ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      ) {
        continue;
      }
      try {
        const key = threadNotificationKey(thread);
        const notification = new Notification(title, {
          body: thread.title,
          tag: key,
          silent: true,
        });
        pending.current.get(key)?.close();
        pending.current.set(key, notification);
        setNotificationBadge(pending.current.size);
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          void openThread();
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    }
  }, [activeEnvironmentId, activeThreadId, inAppNotificationsEnabled, mode, navigate, threads]);

  return null;
}
