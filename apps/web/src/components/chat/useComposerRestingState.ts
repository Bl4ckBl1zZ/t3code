import { useCallback, useEffect, useRef, useState } from "react";
import {
  createComposerReadingGesture,
  recordComposerReadingGesture,
  suppressComposerReadingGesture,
} from "./composerRestingState";

export interface ComposerReadingTimeline {
  getElement: () => HTMLElement | null;
  overflows: () => boolean;
  atEnd: () => boolean;
  onManualNavigation: () => void;
}

export function useComposerRestingState(
  scope: string | null | undefined,
  timeline: ComposerReadingTimeline | undefined,
) {
  const [state, setState] = useState({ scope, collapsed: false });
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const collapsed = state.scope === scope && state.collapsed;
  const setCollapsed = useCallback(
    (value: boolean) =>
      setState((previous) =>
        previous.scope === currentScope.current && previous.collapsed === value
          ? previous
          : { scope: currentScope.current, collapsed: value },
      ),
    [],
  );
  const eligible = useRef(false);
  const latestTimeline = useRef(timeline);
  latestTimeline.current = timeline;
  const gesture = useRef(createComposerReadingGesture());
  const refocusingWindow = useRef(false);
  const expand = useCallback(() => {
    suppressComposerReadingGesture(gesture.current, performance.now());
    setCollapsed(false);
  }, [setCollapsed]);
  useEffect(() => {
    setCollapsed(false);
    gesture.current = createComposerReadingGesture();
  }, [scope, setCollapsed]);
  useEffect(() => {
    let frame: number | null = null;
    const onFocus = () => {
      refocusingWindow.current = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        refocusingWindow.current = false;
      });
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || !(event.target instanceof Element)) return;
      const current = latestTimeline.current;
      const node = current?.getElement();
      if (!node || !node.contains(event.target)) return;
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1);
      if (
        recordComposerReadingGesture(gesture.current, {
          now: performance.now(),
          delta,
          eligible: eligible.current && current!.overflows(),
          canScroll:
            delta < 0
              ? node.scrollTop > 0
              : node.scrollTop < node.scrollHeight - node.clientHeight - 1,
          towardLogicalEnd: delta > 0 && current!.atEnd(),
        })
      )
        setCollapsed(true);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const current = latestTimeline.current;
      const node = current?.getElement();
      if (!node || !node.contains(event.target) || !eligible.current || !current!.overflows())
        return;
      const upward = event.key === "PageUp" || event.key === "Home";
      const downward = event.key === "PageDown" || event.key === "End";
      if (
        (upward && node.scrollTop > 1) ||
        (downward &&
          !current!.atEnd() &&
          node.scrollTop < node.scrollHeight - node.clientHeight - 1)
      ) {
        current!.onManualNavigation();
        setCollapsed(true);
      }
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("wheel", wheel, { capture: true, passive: true });
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("wheel", wheel, true);
      window.removeEventListener("focus", onFocus);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [setCollapsed]);
  useEffect(() => {
    if (!collapsed) return;
    const current = latestTimeline.current;
    const node = current?.getElement();
    if (!node) {
      expand();
      return;
    }
    const resize = () => {
      if (!current!.overflows()) expand();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, [collapsed, expand, timeline]);
  return { collapsed, expand, eligible, refocusingWindow };
}
