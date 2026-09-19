import {
  orchestrationV2TurnItemStatusIsTerminal,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";

import type { TimelineEntry } from "~/session-logic";

export type SubagentTurnItem = Extract<OrchestrationV2TurnItem, { type: "subagent" }>;

/**
 * Subagents this thread has working right now, in timeline order. Read from the
 * entries the timeline already renders, so the badge and the rows it summarizes
 * cannot disagree about what is running.
 */
export function workingSubagentsFromTimeline(
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyArray<SubagentTurnItem> {
  const working: SubagentTurnItem[] = [];
  for (const entry of entries) {
    if (entry.kind !== "event") continue;
    const item = entry.projectedItem.item;
    if (item.type === "subagent" && !orchestrationV2TurnItemStatusIsTerminal(item.status)) {
      working.push(item);
    }
  }
  return working;
}

/** The orb seed the timeline row and the relationships panel also use. */
export function subagentOrbSeed(item: SubagentTurnItem): string {
  return item.childThreadId ?? item.subagentId;
}
