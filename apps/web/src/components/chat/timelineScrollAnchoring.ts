// Match the titlebar fade inset so draft promotion preserves the first row's position.
export const CHAT_TIMELINE_ANCHOR_OFFSET = 24;

export type TimelineScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";

export interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

export interface AnchoredTurnMetrics {
  readonly anchorTop: number;
  readonly lastBottom: number;
  readonly turnHeight: number;
  readonly usableViewportHeight: number;
  readonly visibleUsableBottom: number;
  readonly overflowsUsableViewport: boolean;
  readonly targetScrollToRevealEnd: number;
  readonly scrollDeltaToRevealEnd: number;
}

export function keepTimelineEndVisibleAfterOverlayGrowth({
  timeline,
  previousOverlayHeight,
  overlayHeight,
  followingEnd,
}: {
  readonly timeline: { scrollToEnd: (options: { animated: boolean }) => unknown } | null;
  readonly previousOverlayHeight: number;
  readonly overlayHeight: number;
  readonly followingEnd: boolean;
}): void {
  if (timeline && followingEnd && overlayHeight > previousOverlayHeight) {
    void timeline.scrollToEnd({ animated: false });
  }
}

export interface TimelineScrollSample {
  readonly scrollTop: number;
  readonly contentHeight: number;
}

// Small enough that a deliberate wheel notch or arrow-key press counts, large
// enough that sub-pixel scroll jitter from row remeasurement does not.
export const TIMELINE_USER_SCROLL_UP_THRESHOLD_PX = 8;

/**
 * Backstop for detecting that the reader scrolled away from the live end by
 * means that emit no gesture event on the list (scrollbar drag, keyboard paging,
 * find-in-page). Wheel/touch/pointer gestures are handled directly; this only
 * looks at where the scroller ended up.
 *
 * Shrinking content is never attributed to the user: LegendList's
 * maintainVisibleContentPosition and the browser's own max-scroll clamp both
 * pull the offset up on their own when rows above collapse or the anchored end
 * space is reclaimed.
 */
export function isTimelineUserScrollUp({
  previous,
  next,
  programmaticScrollInFlight,
}: {
  readonly previous: TimelineScrollSample | null;
  readonly next: TimelineScrollSample;
  readonly programmaticScrollInFlight: boolean;
}): boolean {
  if (previous === null || programmaticScrollInFlight) {
    return false;
  }
  if (next.contentHeight < previous.contentHeight - 1) {
    return false;
  }
  return next.scrollTop <= previous.scrollTop - TIMELINE_USER_SCROLL_UP_THRESHOLD_PX;
}

/**
 * The list re-reports "anchor ready" every time the anchored end space resizes,
 * which is once per streamed message or tool call. Positioning is a one-shot at
 * turn start: repeat callbacks must not re-run it, and once the reader has taken
 * over the scroller it must not run at all.
 */
export function shouldPositionTimelineAnchor({
  mode,
  positionedAnchorMessageId,
  messageId,
}: {
  readonly mode: TimelineScrollMode;
  readonly positionedAnchorMessageId: string | null;
  readonly messageId: string;
}): boolean {
  if (mode === "free-scrolling") {
    return false;
  }
  return positionedAnchorMessageId !== messageId;
}

export function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (
    typeof top !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(top) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return top + Math.max(1, height);
}

export function getAnchoredTurnMetrics({
  state,
  anchorIndex,
  composerOverlayHeight,
  anchorOffset,
}: {
  readonly state: TimelineListMeasurementState;
  readonly anchorIndex: number;
  readonly composerOverlayHeight: number;
  readonly anchorOffset: number;
}): AnchoredTurnMetrics | null {
  if (state.data.length === 0) {
    return null;
  }

  const boundedAnchorIndex = Math.max(0, Math.min(anchorIndex, state.data.length - 1));
  const anchorTop = state.positionAtIndex(boundedAnchorIndex);
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (typeof anchorTop !== "number" || !Number.isFinite(anchorTop) || lastBottom === null) {
    return null;
  }

  const usableViewportHeight = Math.max(
    0,
    state.scrollLength - composerOverlayHeight - anchorOffset,
  );
  const turnHeight = Math.max(0, lastBottom - anchorTop);
  const visibleUsableBottom = state.scroll + usableViewportHeight;
  const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight);
  const scrollDeltaToRevealEnd = Math.max(0, targetScrollToRevealEnd - state.scroll);

  return {
    anchorTop,
    lastBottom,
    turnHeight,
    usableViewportHeight,
    visibleUsableBottom,
    overflowsUsableViewport: turnHeight > usableViewportHeight,
    targetScrollToRevealEnd,
    scrollDeltaToRevealEnd,
  };
}
