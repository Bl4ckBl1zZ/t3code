import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

/**
 * Trims a thread projection to roughly the last `maxVisibleItems` visible turn
 * items so cold loads transfer (and decode) a bounded tail instead of the full
 * history. The cut is extended backwards to the nearest run boundary: turn-item
 * visibility rules pair items within a run (e.g. interrupt request/result), so
 * a run must never be split across the window edge.
 *
 * Only the three history-proportional arrays are trimmed — `visibleTurnItems`,
 * `turnItems`, and `messages`. Runs, attempts, nodes, and the other entity
 * arrays stay complete: they are small, and visibility recomputation on the
 * client reads them.
 *
 * The number of visible items dropped is recorded in
 * `truncatedVisibleItemCount` so clients can offer to load the full history.
 */
export function windowOrchestrationV2ThreadProjection(
  projection: OrchestrationV2ThreadProjection,
  maxVisibleItems: number,
): OrchestrationV2ThreadProjection {
  const rows = projection.visibleTurnItems;
  // Normalize rather than trust the caller: a fractional or NaN window would
  // produce a fractional cut index and crash on `rows[cut]` below.
  const window = Math.floor(maxVisibleItems);
  if (!Number.isFinite(window) || window <= 0 || rows.length <= window) {
    return projection;
  }

  let cut = rows.length - window;
  const boundaryRunId = rows[cut]!.item.runId;
  if (boundaryRunId !== null) {
    while (cut > 0 && rows[cut - 1]!.item.runId === boundaryRunId) {
      cut -= 1;
    }
  }
  if (cut === 0) {
    return projection;
  }

  const kept = rows
    .slice(cut)
    .map((row, position) => (row.position === position ? row : { ...row, position }));
  const keptItemIds = new Set(kept.map((row) => row.sourceItemId));
  const keptRunIds = new Set(
    kept.flatMap((row) => (row.item.runId === null ? [] : [row.item.runId])),
  );

  return {
    ...projection,
    visibleTurnItems: kept,
    turnItems: projection.turnItems.filter(
      (item) => keptItemIds.has(item.id) || (item.runId !== null && keptRunIds.has(item.runId)),
    ),
    // Messages without a run (rare, e.g. system notices) are kept: they cannot
    // be re-associated with a window edge and are not history-proportional.
    messages: projection.messages.filter(
      (message) => message.runId === null || keptRunIds.has(message.runId),
    ),
    truncatedVisibleItemCount: (projection.truncatedVisibleItemCount ?? 0) + cut,
  };
}

/**
 * Merges a full (unwindowed) snapshot of the same thread into a currently
 * windowed projection: rows the window dropped are prepended while everything
 * the live stream has updated since stays authoritative. Used by "load earlier
 * history" — the full snapshot may be slightly older than the live projection,
 * so current entities always win over the snapshot's copies.
 */
export function mergeOrchestrationV2FullHistory(
  current: OrchestrationV2ThreadProjection,
  full: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const currentVisibleIds = new Set(current.visibleTurnItems.map((row) => row.sourceItemId));
  const olderRows = full.visibleTurnItems.filter((row) => !currentVisibleIds.has(row.sourceItemId));
  const visibleTurnItems = [...olderRows, ...current.visibleTurnItems].map((row, position) =>
    row.position === position ? row : { ...row, position },
  );

  const currentItemIds = new Set(current.turnItems.map((item) => item.id));
  const currentMessageIds = new Set(current.messages.map((message) => message.id));

  return {
    ...current,
    visibleTurnItems,
    turnItems: [
      ...full.turnItems.filter((item) => !currentItemIds.has(item.id)),
      ...current.turnItems,
    ],
    messages: [
      ...full.messages.filter((message) => !currentMessageIds.has(message.id)),
      ...current.messages,
    ],
    truncatedVisibleItemCount: undefined,
  };
}
