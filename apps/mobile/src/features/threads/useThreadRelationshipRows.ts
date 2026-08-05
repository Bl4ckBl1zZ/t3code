import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  resolveMergeBackTargetThreadId,
  type ThreadRelationshipEdge,
} from "@t3tools/client-runtime/state/thread-relationships";
import {
  canDetachThreadProviderSession,
  resolveLatestMergeBackRun,
} from "@t3tools/client-runtime/state/thread-workflows";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { copySorted } from "@t3tools/shared/Array";
import type { SFSymbol } from "expo-symbols";
import { useEffect, useMemo, useRef, useState } from "react";

import type { AgentOrbState } from "../../components/AgentOrb";
import { useThreadShells } from "../../state/entities";
import { useThreadProjection } from "../../state/use-thread-detail";
import { useArchivedThreadSnapshots } from "../archive/useArchivedThreadSnapshots";

export function relationshipLabel(edge: ThreadRelationshipEdge, currentThreadId: ThreadId): string {
  if (edge.kind === "transfer") {
    return edge.sourceThreadId === currentThreadId ? "Context sent to" : "Context received from";
  }
  if (edge.kind === "subagent") {
    return edge.sourceThreadId === currentThreadId ? "Subagent" : "Parent agent";
  }
  return edge.sourceThreadId === currentThreadId ? "Fork" : "Forked from";
}

export function relationshipSymbol(edge: ThreadRelationshipEdge): SFSymbol {
  if (edge.kind === "transfer") return "arrow.left.arrow.right";
  return "arrow.triangle.branch";
}

export function subagentEdgeOrbState(status: string | null): AgentOrbState {
  if (status === "failed") return "failed";
  if (status === "running") return "active";
  return "done";
}

export function threadAvailability(
  thread: OrchestrationV2ThreadShell | null,
  missing: boolean,
): string | null {
  if (missing) return "Unavailable";
  if (thread?.deletedAt !== null && thread?.deletedAt !== undefined) return "Deleted";
  if (thread?.archivedAt !== null && thread?.archivedAt !== undefined) return "Archived";
  return null;
}

// A finished subagent edge stays visible for a minute, then collapses into
// the trailing "Done · N" group. Failed edges never auto-collapse.
const SUBAGENT_DECAY_MS = 60_000;
const DECAY_TERMINAL_STATUSES = new Set(["completed", "cancelled", "interrupted"]);

const EMPTY_THREAD_SHELLS: ReadonlyArray<OrchestrationV2ThreadShell> = [];

/**
 * The thread's immediate lineage — parents, forks, transfers, and subagents —
 * derived from the same graph the desktop details panel renders, with finished
 * subagents split off into the collapsed "Done" group.
 *
 * Shared by the banner above the transcript and the thread details sheet so the
 * two surfaces cannot disagree about what this thread is related to.
 */
export function useThreadRelationshipRows(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const scopedProjection = useThreadProjection(props);
  const projection = scopedProjection?.projection ?? null;
  const threadShells = useThreadShells();
  const environmentIds = useMemo(() => [props.environmentId], [props.environmentId]);
  const archived = useArchivedThreadSnapshots(environmentIds);
  const archivedShells =
    archived.snapshots.find((entry) => entry.environmentId === props.environmentId)?.snapshot
      .threads ?? EMPTY_THREAD_SHELLS;
  const shells = useMemo<ReadonlyArray<OrchestrationV2ThreadShell>>(() => {
    const environmentShells: OrchestrationV2ThreadShell[] = [];
    for (const thread of threadShells) {
      if (thread.environmentId === props.environmentId) {
        environmentShells.push(thread.source);
      }
    }
    environmentShells.push(...archivedShells);
    return environmentShells;
  }, [archivedShells, props.environmentId, threadShells]);
  const graph = useMemo(
    () => deriveThreadRelationshipGraph({ threads: shells, projection }),
    [projection, shells],
  );
  const mergeTargetThreadId = resolveMergeBackTargetThreadId(projection);
  const rows = useMemo(
    () =>
      copySorted(
        immediateThreadRelationships(graph, props.threadId),
        (left, right) =>
          Number(right.threadId === mergeTargetThreadId) -
          Number(left.threadId === mergeTargetThreadId),
      ),
    [graph, mergeTargetThreadId, props.threadId],
  );
  const latestMergeBackRun = projection === null ? null : resolveLatestMergeBackRun(projection);
  const canMerge = mergeTargetThreadId !== null && latestMergeBackRun !== null;
  const canDetach = projection ? canDetachThreadProviderSession(projection) : false;

  const [decayTick, setDecayTick] = useState(0);
  // edgeKey -> timestamp after which the edge collapses into the Done group.
  const decayExpiryRef = useRef<Map<string, number>>(new Map());
  const observedOnceRef = useRef(false);

  useEffect(() => {
    const expiries = decayExpiryRef.current;
    const liveKeys = new Set<string>();
    let changed = false;
    for (const { threadId, edge } of rows) {
      if (edge.kind !== "subagent") continue;
      const key = `${edge.kind}:${threadId}`;
      liveKeys.add(key);
      if (edge.status !== null && DECAY_TERMINAL_STATUSES.has(edge.status)) {
        if (!expiries.has(key)) {
          // Edges already terminal on first observation go straight to the
          // archived group; later completions linger for the decay window.
          expiries.set(key, observedOnceRef.current ? Date.now() + SUBAGENT_DECAY_MS : 0);
          changed = true;
        }
      } else if (expiries.delete(key)) {
        changed = true;
      }
    }
    for (const key of expiries.keys()) {
      if (!liveKeys.has(key)) {
        expiries.delete(key);
        changed = true;
      }
    }
    observedOnceRef.current = true;
    if (changed) setDecayTick((tick) => tick + 1);
    const pending = [...expiries.values()].filter((expiry) => expiry > Date.now());
    if (pending.length === 0) return;
    const timeout = setTimeout(
      () => setDecayTick((tick) => tick + 1),
      Math.min(...pending) - Date.now() + 50,
    );
    return () => clearTimeout(timeout);
  }, [rows, decayTick]);

  const decayNow = Date.now();
  const visibleRows: typeof rows = [];
  const archivedRows: typeof rows = [];
  for (const row of rows) {
    const expiry = decayExpiryRef.current.get(`${row.edge.kind}:${row.threadId}`);
    if (expiry !== undefined && expiry <= decayNow) archivedRows.push(row);
    else visibleRows.push(row);
  }

  return {
    archivedRows,
    canDetach,
    canMerge,
    graph,
    latestMergeBackRun,
    mergeTargetThreadId,
    rows,
    visibleRows,
  };
}

export type ThreadRelationshipRow = ReturnType<typeof useThreadRelationshipRows>["rows"][number];
