import type { LegendListRef } from "@legendapp/list/react";
import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { ThreadFindMatch } from "./threadFind";
import { useThreadFindHighlights } from "./threadFindHighlights";

const FIND_MATCH_VIEW_MARGIN = 96;

/**
 * Scrolls the selected match's row into the list, then only enough to reveal the
 * active text. The web loads whole thread snapshots, so every match has a row.
 */
export function useThreadFindNavigation({
  container,
  query,
  match,
  navigationId,
  rowIndex,
  entries,
  listRef,
  contentInsetEndAdjustment,
  listReady,
}: {
  container: HTMLElement | null;
  query: string;
  match: ThreadFindMatch | null;
  navigationId: number;
  rowIndex: number;
  entries: readonly { readonly id: string }[];
  listRef: RefObject<LegendListRef | null>;
  contentInsetEndAdjustment: number;
  listReady: boolean;
}) {
  const matchKey = match ? `${navigationId}:${query}:${match.entryId}:${match.occurrence}` : null;
  const positioningRef = useRef<{
    key: string;
    rowIndex: number;
    entries: typeof entries;
  } | null>(null);
  const settledMatchRef = useRef<string | null>(null);
  const currentMatchKeyRef = useRef(matchKey);
  const activeRangeRef = useRef<Range | null>(null);
  const revealRef = useRef<(range: Range | null) => void>(() => {});
  useLayoutEffect(() => {
    currentMatchKeyRef.current = matchKey;
    return () => {
      currentMatchKeyRef.current = null;
    };
  }, [matchKey]);
  const revealedMatchRef = useRef<string | null>(null);
  const positionedEntriesRef = useRef<typeof entries | null>(null);
  const reveal = useCallback(
    (range: Range | null) => {
      activeRangeRef.current = range;
      if (!matchKey) {
        positioningRef.current = null;
        settledMatchRef.current = null;
        revealedMatchRef.current = null;
        return;
      }
      if (revealedMatchRef.current === matchKey) return;
      if (!listReady || rowIndex < 0) return;
      const materialize = () => {
        const list = listRef.current;
        const previous = positioningRef.current;
        if (
          !list ||
          (previous?.key === matchKey &&
            previous.rowIndex === rowIndex &&
            previous.entries === entries)
        )
          return;
        // Activity can insert rows while LegendList waits for layout. Retarget the
        // pending jump instead of treating the first requested index as final.
        const request = { key: matchKey, rowIndex, entries };
        positioningRef.current = request;

        void list
          .scrollToIndex({
            index: rowIndex,
            animated: false,
            viewOffset: FIND_MATCH_VIEW_MARGIN,
          })
          .then(() => {
            if (positioningRef.current !== request || currentMatchKeyRef.current !== matchKey)
              return;

            positionedEntriesRef.current = entries;
            settledMatchRef.current = matchKey;
            revealRef.current(activeRangeRef.current);
          });
      };
      if (!range) {
        if (container) materialize();
        return;
      }

      const codeScroller = range.startContainer.parentElement?.closest("pre");
      if (codeScroller) {
        const rect = range.getBoundingClientRect();
        const viewport = codeScroller.getBoundingClientRect();
        if (rect.left < viewport.left) codeScroller.scrollLeft += rect.left - viewport.left - 16;
        else if (rect.right > viewport.right)
          codeScroller.scrollLeft += rect.right - viewport.right + 16;
      }
      const rect = range.getBoundingClientRect();
      const viewport = container?.getBoundingClientRect();
      if (!viewport || rect.height === 0) return;
      // Shrink the margin when the band above the composer is short, so the match stays inside it.
      const margin = Math.min(
        FIND_MATCH_VIEW_MARGIN,
        Math.max(0, (viewport.height - contentInsetEndAdjustment - rect.height) / 2),
      );
      const top = viewport.top + margin;
      const bottom = viewport.bottom - margin - contentInsetEndAdjustment;
      const delta =
        rect.top < top ? rect.top - top : rect.bottom > bottom ? rect.bottom - bottom : 0;
      // A new list can expose DOM text before its virtual row sizes settle.
      // Await row positioning before measuring an offscreen occurrence.
      if (
        Math.abs(delta) >= 1 &&
        positionedEntriesRef.current !== entries &&
        settledMatchRef.current !== matchKey
      ) {
        materialize();
        return;
      }
      const scroll = listRef.current?.getState?.().scroll;
      positionedEntriesRef.current = entries;

      revealedMatchRef.current = matchKey;
      if (Math.abs(delta) >= 1 && typeof scroll === "number") {
        listRef.current?.scrollToOffset({ offset: scroll + delta, animated: false });
        // Scrolling can mount rows whose measured heights move the selected text again.
        requestAnimationFrame(() => {
          if (currentMatchKeyRef.current !== matchKey) return;
          if (
            listRef.current?.getState?.().scroll === scroll &&
            range.getBoundingClientRect().top === rect.top
          )
            return;
          revealedMatchRef.current = null;
          revealRef.current(activeRangeRef.current);
        });
      }
    },
    [container, contentInsetEndAdjustment, entries, listRef, listReady, matchKey, rowIndex],
  );

  useLayoutEffect(() => {
    revealRef.current = reveal;
  }, [reveal]);

  useThreadFindHighlights({
    container,
    query,
    activeRowId: match?.entryId ?? null,
    activeOccurrence: match?.occurrence ?? 0,
    onActiveRange: reveal,
  });
}
