import {
  orchestrationV2TurnItemStatusIsTerminal,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect, useRef } from "react";

/** V2 completion timestamps, including commands that can modify unreported paths. */
export function latestWorkspaceMutationId(
  rows: ReadonlyArray<{
    readonly sourceThreadId: string;
    readonly item: Pick<
      OrchestrationV2ProjectedTurnItem["item"],
      "id" | "type" | "status" | "updatedAt"
    >;
  }>,
): string | null {
  let latest: string | null = null;
  let latestAt = -Infinity;
  for (const { item, sourceThreadId } of rows) {
    if (
      (item.type !== "file_change" && item.type !== "command_execution") ||
      !orchestrationV2TurnItemStatusIsTerminal(item.status)
    )
      continue;
    const at = DateTime.toEpochMillis(item.updatedAt);
    if (at >= latestAt) {
      latestAt = at;
      latest = `${sourceThreadId}:${item.id}:${at}`;
    }
  }
  return latest;
}

export function workspaceMutationRefreshToken(
  resourceKey: string,
  mutationId: string | null,
): string | null {
  return mutationId === null ? null : `${resourceKey}\u0000${mutationId}`;
}

/**
 * Refreshes once per mutation and resource. Disabled mutations stay pending,
 * which lets an editable file catch up after its local save finishes.
 */
export function useWorkspaceMutationRefresh(input: {
  readonly enabled?: boolean;
  readonly mutationId: string | null;
  readonly refresh: () => void;
  readonly resourceKey: string;
}): void {
  const { enabled = true, mutationId, refresh, resourceKey } = input;
  const handledTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const token = workspaceMutationRefreshToken(resourceKey, mutationId);
    if (token === null || token === handledTokenRef.current) return;
    handledTokenRef.current = token;
    refresh();
  }, [enabled, mutationId, refresh, resourceKey]);
}
