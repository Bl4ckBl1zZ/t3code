import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { orchestrationEnvironment } from "../state/orchestration";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { waitForAtomValue } from "../state/waitForAtomValue";

const ARCHIVED_SNAPSHOT_LOAD_TIMEOUT_MS = 5_000;

function archivedSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedShellSnapshot({
    environmentId,
    input: {},
  });
}

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: archivedSnapshotAtom,
  labelPrefix: "web:archived-thread-snapshots",
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
}

/**
 * Archived threads live outside the main shell store, but they still hold
 * `worktreePath`, so worktree cleanup has to see them: an archived thread can
 * be the last owner of a worktree, or the one sharer that makes another
 * thread's worktree not orphaned. Resolves to `[]` if the snapshot cannot be
 * loaded in time — callers treat that as "no archived sharers", matching the
 * behaviour from before archived threads were consulted at all.
 */
export async function loadArchivedThreadShells(
  environmentId: EnvironmentId,
): Promise<ReadonlyArray<OrchestrationV2ThreadShell>> {
  const atom = archivedSnapshotAtom(environmentId);
  await waitForAtomValue({
    registry: appAtomRegistry,
    atom,
    predicate: AsyncResult.isNotInitial,
    timeoutMs: ARCHIVED_SNAPSHOT_LOAD_TIMEOUT_MS,
  });
  const snapshot = Option.getOrNull(AsyncResult.value(appAtomRegistry.get(atom)));
  return snapshot?.threads ?? [];
}

export function useArchivedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const environmentKey = useMemo(
    () => makeArchivedThreadsEnvironmentKey(environmentIds),
    [environmentIds],
  );
  const result = useAtomValue(archivedSnapshotsAtom(environmentKey));
  const refresh = useCallback(() => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
    }
  }, [environmentIds]);

  return {
    ...result,
    refresh,
  };
}
