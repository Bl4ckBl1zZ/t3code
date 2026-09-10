import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { buildThreadRouteParams } from "../threadRoutes";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { makeWorkspaceFileDropHandlers } from "../components/chat/workspaceFileDrop";

export function useSidebarFileDropNavigation(
  navigateToThread: (ref: ScopedThreadRef) => Promise<void>,
) {
  const router = useRouter();
  return useCallback(
    async (threadRef: ScopedThreadRef, files: File[]) => {
      if (files.length === 0) return;
      const store = useSidebarPendingFileDropStore.getState();
      const dropId = store.queuePendingFileDrop({ threadRef, files });
      const target = router.buildLocation({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      }).pathname;
      if (target === router.state.location.pathname) return;
      try {
        await navigateToThread(threadRef);
        if (target !== router.state.location.pathname) store.clearPendingFileDrop(dropId);
      } catch {
        store.clearPendingFileDrop(dropId);
      }
    },
    [navigateToThread, router],
  );
}

export function useSidebarFileDropTarget(
  threadRef: ScopedThreadRef,
  onDrop: ((threadRef: ScopedThreadRef, files: File[]) => void) | undefined,
) {
  const [active, setActive] = useState(false);
  const handlers = useMemo(
    () =>
      onDrop
        ? makeWorkspaceFileDropHandlers({
            setDragActive: setActive,
            addFiles: (files) => onDrop(threadRef, files),
          })
        : {},
    [onDrop, threadRef],
  );
  useEffect(() => {
    if (!active) return;
    const clear = () => setActive(false);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
      window.removeEventListener("blur", clear);
    };
  }, [active]);
  return { active, handlers };
}
