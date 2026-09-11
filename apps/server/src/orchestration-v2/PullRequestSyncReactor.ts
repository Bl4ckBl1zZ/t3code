import { parseChangeRequestUrl, siblingPullRequestUrl } from "@t3tools/shared/changeRequestUrl";
import {
  CommandId,
  type OrchestrationV2ThreadShell,
  type PullRequestSummary,
  type ThreadPullRequestKey,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
  type ThreadPullRequestStack,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  threadPullRequestKeyOf,
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequestChains";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { allThreadPullRequestsOf } from "@t3tools/shared/threadPullRequests";
import * as Stream from "effect/Stream";

const SLOW_SYNC_INTERVAL_MS = 15 * 60 * 1_000;

type SnapshotFields = Omit<ThreadPullRequestSnapshot, "syncedAt">;

interface LinkEntry {
  readonly thread: OrchestrationV2ThreadShell;
  readonly link: ThreadPullRequestLink;
}

function snapshotFieldsOf(summary: PullRequestSummary): SnapshotFields {
  return {
    state: summary.state,
    title: summary.title,
    headBranch: summary.headBranch,
    baseBranch: summary.baseBranch,
    isDraft: summary.isDraft ?? false,
    updatedAt: summary.updatedAt,
    closedAt: summary.closedAt ?? null,
    mergedAt: summary.mergedAt ?? null,
    ...(summary.author === undefined ? {} : { author: summary.author }),
    ...(summary.additions === undefined ? {} : { additions: summary.additions }),
    ...(summary.deletions === undefined ? {} : { deletions: summary.deletions }),
    ...(summary.changedFiles === undefined ? {} : { changedFiles: summary.changedFiles }),
    ...(summary.reviewDecision === undefined ? {} : { reviewDecision: summary.reviewDecision }),
    ...(summary.checksState === undefined ? {} : { checksState: summary.checksState }),
    ...(summary.mergeability === undefined ? {} : { mergeability: summary.mergeability }),
  };
}

function snapshotFieldsEqual(left: SnapshotFields, right: SnapshotFields): boolean {
  return (
    left.state === right.state &&
    left.title === right.title &&
    left.headBranch === right.headBranch &&
    left.baseBranch === right.baseBranch &&
    left.isDraft === right.isDraft &&
    left.updatedAt === right.updatedAt &&
    (left.closedAt ?? null) === (right.closedAt ?? null) &&
    (left.mergedAt ?? null) === (right.mergedAt ?? null) &&
    (left.author?.login ?? null) === (right.author?.login ?? null) &&
    (left.author?.avatarUrl ?? null) === (right.author?.avatarUrl ?? null) &&
    left.additions === right.additions &&
    left.deletions === right.deletions &&
    left.changedFiles === right.changedFiles &&
    (left.reviewDecision ?? null) === (right.reviewDecision ?? null) &&
    (left.checksState ?? null) === (right.checksState ?? null) &&
    left.mergeability === right.mergeability
  );
}

function stacksEqual(
  left: ThreadPullRequestStack | null,
  right: ThreadPullRequestStack | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.number === right.number &&
    left.url === right.url &&
    left.base === right.base &&
    left.layers.length === right.layers.length &&
    left.layers.every((layer, index) => {
      const other = right.layers[index]!;
      return (
        layer.number === other.number &&
        layer.headBranch === other.headBranch &&
        layer.state === other.state
      );
    })
  );
}

function isUnsettled(thread: OrchestrationV2ThreadShell): boolean {
  return thread.settledOverride !== "settled" && thread.settledAt === null;
}

/**
 * Keeps every thread ↔ pull request link's host snapshot current. One sweep a minute reads
 * the shell snapshot, groups visible links by pull request so the host is asked once per PR
 * no matter how many threads share it, and writes back only what changed. Native stacks the
 * host reports are auto-linked to the thread as `source: "stack"`.
 */
export class PullRequestSyncReactor extends Context.Service<
  PullRequestSyncReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    /** Force the next sweep to re-read this pull request, even when its snapshot is terminal. */
    readonly requestSync: (key: ThreadPullRequestKey) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/PullRequestSyncReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;

  const lastSyncedAt = new Map<string, number>();
  const requested = new Map<string, number>();
  let requestGeneration = 0;
  const retryStacks = new Set<string>();

  const isDue = (key: string, entries: ReadonlyArray<LinkEntry>, nowMs: number): boolean => {
    if (requested.has(key) || retryStacks.has(key)) return true;
    if (entries.some((entry) => entry.link.snapshot === null)) return true;
    if (entries.every((entry) => entry.link.snapshot?.state === "merged")) return false;
    if (entries.some((entry) => entry.link.snapshot?.state === "open" && isUnsettled(entry.thread)))
      return true;
    // Closed requests can reopen on the host, including after the thread settles.
    const last = lastSyncedAt.get(key);
    return last === undefined || nowMs - last >= SLOW_SYNC_INTERVAL_MS;
  };

  const logSkipped =
    (message: string, fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logWarning(message, fields);

  const sweep = Effect.fn("PullRequestSyncReactor.sweep")(function* () {
    const snapshot = yield* threads.getShellSnapshot({ location: "active" });
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const nowIso = DateTime.formatIso(now);

    const groups = new Map<string, Array<LinkEntry>>();
    for (const thread of snapshot.threads) {
      if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
      for (const link of visibleThreadPullRequests(allThreadPullRequestsOf(thread))) {
        const key = threadPullRequestKeyOf(link);
        const entries = groups.get(key) ?? [];
        entries.push({ thread, link });
        groups.set(key, entries);
      }
    }

    for (const key of lastSyncedAt.keys()) if (!groups.has(key)) lastSyncedAt.delete(key);
    for (const key of retryStacks) if (!groups.has(key)) retryStacks.delete(key);
    for (const key of requested.keys()) if (!groups.has(key)) requested.delete(key);

    // Layers auto-linked this sweep, so two links of one thread that share a
    // stack do not both try to add the same sibling.
    const linkedThisSweep = new Set<string>();

    const syncEntry = Effect.fn("PullRequestSyncReactor.syncEntry")(function* (
      entry: LinkEntry,
      fields: SnapshotFields,
      fetchedStack: { readonly stack: ThreadPullRequestStack | null } | null,
    ) {
      const { thread, link } = entry;
      const nextStack = fetchedStack === null ? link.stack : fetchedStack.stack;
      const changed =
        link.snapshot === null ||
        !snapshotFieldsEqual(link.snapshot, fields) ||
        !stacksEqual(link.stack, nextStack);
      if (changed) {
        const uuid = yield* crypto.randomUUIDv4;
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`server:pr-sync:${thread.id}:${uuid}`),
          threadId: thread.id,
          expectedProjectId: thread.projectId,
          syncPullRequest: {
            reference: link,
            snapshot: { ...fields, syncedAt: nowIso },
            stack: nextStack,
          },
        });
      }
      if (fetchedStack === null || fetchedStack.stack === null) return;
      const current = yield* threads.getThreadShell(thread.id);
      if (!current || current.archivedAt !== null || current.deletedAt !== null) return;
      const currentLinks = allThreadPullRequestsOf(current);
      if (
        !visibleThreadPullRequests(currentLinks).some(
          (item) =>
            threadPullRequestKeysEqual(item, link) &&
            item.source === link.source &&
            item.linkedAt === link.linkedAt,
        )
      )
        return;
      for (const layer of fetchedStack.stack.layers) {
        const layerKey = { host: link.host, repository: link.repository, number: layer.number };
        const dedupeKey = `${thread.id}:${threadPullRequestKeyOf(layerKey)}`;
        if (linkedThisSweep.has(dedupeKey)) continue;
        // Tombstones count as present: a dismissed layer is never re-added.
        if (currentLinks.some((existing) => threadPullRequestKeysEqual(existing, layerKey))) {
          continue;
        }
        const url = siblingPullRequestUrl(link.url, layer.number);
        if (url === null) continue;
        linkedThisSweep.add(dedupeKey);
        const uuid = yield* crypto.randomUUIDv4;
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`server:pr-stack-link:${thread.id}:${uuid}`),
            threadId: thread.id,
            expectedProjectId: thread.projectId,
            linkPullRequest: {
              projectId: link.projectId ?? thread.projectId,
              repository: link.repository,
              number: layer.number,
              url,
            },
            linkPullRequestSource: "stack",
            expectedPullRequestLink: link,
          })
          .pipe(
            Effect.catchCause(
              logSkipped("pull request stack layer link skipped", {
                threadId: thread.id,
                number: layer.number,
              }),
            ),
          );
      }
    });

    const syncGroup = Effect.fn("PullRequestSyncReactor.syncGroup")(function* (
      key: string,
      entries: ReadonlyArray<LinkEntry>,
    ) {
      const first = entries[0]!;
      const ref = {
        projectId: first.link.projectId ?? first.thread.projectId,
        host: first.link.host,
        repository: first.link.repository,
        number: first.link.number,
      };
      const generation = requested.get(key);
      if (generation !== undefined) yield* pullRequests.invalidate({ reference: ref });
      const summary = yield* pullRequests.summary(ref);
      const fields = snapshotFieldsOf(summary);
      const needsStack =
        generation !== undefined ||
        retryStacks.has(key) ||
        entries.some(
          (entry) =>
            entry.link.snapshot === null || !snapshotFieldsEqual(entry.link.snapshot, fields),
        );
      const fetchedStack = needsStack
        ? yield* pullRequests.stack(ref, { includeDetails: false }).pipe(
            Effect.map((stack) => ({
              stack: stack === null ? null : ({ kind: "native", ...stack } as const),
            })),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("pull request stack lookup failed", {
                    key,
                  }).pipe(Effect.as(null)),
            ),
          )
        : null;
      if (needsStack) {
        if (fetchedStack === null) retryStacks.add(key);
        else retryStacks.delete(key);
      }
      // The host answered, so the cadence clock ticks even if a dispatch below is rejected.
      lastSyncedAt.set(key, nowMs);
      // A refresh requested while the host read was in flight belongs to the next sweep.
      if (requested.get(key) === generation) requested.delete(key);
      yield* Effect.forEach(
        entries,
        (entry) =>
          syncEntry(entry, fields, fetchedStack).pipe(
            Effect.catchCause(
              logSkipped("pull request sync skipped", { threadId: entry.thread.id, key }),
            ),
          ),
        { discard: true },
      );
    });

    yield* Effect.forEach(
      groups,
      ([key, entries]) =>
        isDue(key, entries, nowMs)
          ? syncGroup(key, entries).pipe(
              Effect.catchCause(logSkipped("pull request sync skipped", { key })),
            )
          : Effect.void,
      { concurrency: 8, discard: true },
    );
  });

  let sweepQueued = false;
  const worker = yield* makeDrainableWorker(() =>
    Effect.suspend(() => {
      sweepQueued = false;
      return sweep().pipe(Effect.catchCause(logSkipped("pull request sync sweep failed", {})));
    }),
  );
  const enqueueSweep = Effect.suspend(() => {
    if (sweepQueued) return Effect.void;
    sweepQueued = true;
    return worker.enqueue(undefined).pipe(Effect.asVoid);
  });

  const start: PullRequestSyncReactor["Service"]["start"] = Effect.fn(
    "PullRequestSyncReactor.start",
  )(function* () {
    const merges = yield* pullRequests.subscribeMerges;
    yield* forkParked(
      Stream.runForEach(merges, (event) => requestSync(parseChangeRequestUrl(event.url) ?? event)),
    );
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.metadata-updated" &&
          event.type !== "thread.created" &&
          event.type !== "thread.unarchived"
        )
          return Effect.void;
        return visibleThreadPullRequests(allThreadPullRequestsOf(event.payload)).some(
          (link) => link.snapshot === null,
        )
          ? enqueueSweep
          : Effect.void;
      }),
    );
    yield* forkParked(
      Effect.gen(function* () {
        yield* enqueueSweep;
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
  });

  const requestSync: PullRequestSyncReactor["Service"]["requestSync"] = (key) =>
    Effect.suspend(() => {
      requested.set(threadPullRequestKeyOf(key), ++requestGeneration);
      return enqueueSweep;
    });

  return { start, drain: worker.drain, requestSync } satisfies PullRequestSyncReactor["Service"];
});

export const layer = Layer.effect(PullRequestSyncReactor, make);
