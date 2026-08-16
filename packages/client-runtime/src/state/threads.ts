import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import { ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { mergeOrchestrationV2FullHistory } from "@t3tools/shared/orchestrationV2Window";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

function statusWithoutLiveData(
  data: Option.Option<OrchestrationV2ThreadProjection>,
): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

function shouldPersistThread(thread: OrchestrationV2ThreadProjection): boolean {
  return !thread.runs.some(
    (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
  );
}

export interface EnvironmentThreadStateOptions {
  /**
   * When set, initial snapshots (HTTP and socket) are windowed to roughly the
   * last N visible turn items; the full history loads on demand via
   * {@link requestThreadFullHistory}.
   */
  readonly snapshotWindow?: number;
}

// Registered by each live thread state machine so UI code can ask for the full
// history of a windowed thread without holding a reference into the machine.
const fullHistoryRequestHandlers = new Map<string, () => void>();

/**
 * Asks the live state machine for `environmentId`/`threadId` to replace its
 * windowed projection with the complete history. Returns false when the thread
 * has no live machine (nothing to do) — safe to call unconditionally.
 */
export function requestThreadFullHistory(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
): boolean {
  const handler = fullHistoryRequestHandlers.get(threadKey({ environmentId, threadId }));
  if (handler === undefined) return false;
  handler();
  return true;
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
  options?: EnvironmentThreadStateOptions,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationV2ThreadDetailSnapshot>()),
      ),
    ),
  );
  const cachedThread = Option.map(cached, (snapshot) => snapshot.projection);
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
  });
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  );
  const awaitingCompletion = yield* Ref.make(false);
  const incoming = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
  const persistence = yield* Queue.sliding<OrchestrationV2ThreadDetailSnapshot>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationV2ThreadDetailSnapshot,
  ) {
    yield* cache.saveThread(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const setSynchronizing = SubscriptionRef.update(state, (current) =>
    current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setDisconnected = Effect.gen(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
    }));
  });
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status:
            current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
          error: Option.some(formatThreadError(cause)),
        })),
      ),
    );

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationV2ThreadProjection,
  ) {
    const waiting = yield* Ref.get(awaitingCompletion);
    yield* SubscriptionRef.set(state, {
      data: Option.some(thread),
      status: waiting ? "synchronizing" : "live",
      error: Option.none(),
    });
    // Active projections can update many times per second and retain large tool
    // payloads. Persist once the run settles so cache encoding stays off the
    // streaming path.
    if (shouldPersistThread(thread)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(persistence, { snapshotSequence, projection: thread });
    }
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
    });
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  // Replay after a stale cache can carry thousands of events; folding a whole
  // chunk into the projection before touching the SubscriptionRef keeps catch-up
  // at one render per batch instead of one per event.
  const applyItems = Effect.fn("EnvironmentThreadState.applyItems")(function* (
    items: Iterable<OrchestrationV2ThreadStreamItem>,
  ) {
    let sequence = yield* SubscriptionRef.get(lastSequence);
    let current = yield* SubscriptionRef.get(state);
    let data = current.data;
    let changed = false;
    let sawSynchronized = false;

    for (const item of items) {
      if (item.kind === "synchronized") {
        yield* Ref.set(awaitingCompletion, false);
        sawSynchronized = true;
        continue;
      }

      if (item.kind === "snapshot") {
        sequence = item.snapshotSequence;
        data = Option.some(item.projection);
        changed = true;
        continue;
      }

      if (item.sequence <= sequence) {
        continue;
      }
      sequence = item.sequence;

      if (item.event.type === "thread.deleted") {
        yield* SubscriptionRef.set(lastSequence, sequence);
        yield* setDeleted();
        current = yield* SubscriptionRef.get(state);
        data = Option.none();
        changed = false;
        continue;
      }
      if (Option.isNone(data)) {
        continue;
      }
      const next = applyOrchestrationV2ProjectionEvent(data.value, item.event);
      if (next !== null) {
        data = Option.some(next);
        changed = true;
      }
    }

    yield* SubscriptionRef.set(lastSequence, sequence);
    if (changed && Option.isSome(data)) {
      yield* setThread(data.value);
    } else if (sawSynchronized) {
      yield* SubscriptionRef.update(state, (value) =>
        Option.isSome(value.data) && value.status !== "deleted"
          ? { ...value, status: "live" as const, error: Option.none() }
          : value,
      );
    }
  });

  const applyItem = (item: OrchestrationV2ThreadStreamItem) => applyItems([item]);

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamic(
      ORCHESTRATION_V2_WS_METHODS.subscribeThread,
      Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
        yield* setSynchronizing;

        // The config round-trip and the cold-cache HTTP snapshot are
        // independent; running them serially added a full RTT (and up to the
        // snapshot timeout) before the subscribe frame could go out.
        const fetchServerSupport = session.initialConfig.pipe(
          Effect.map((config) => ({
            completionMarker: config.threadResumeCompletionMarker === true,
            snapshotWindow: config.threadSnapshotWindow === true,
          })),
          Effect.orElseSucceed(() => ({ completionMarker: false, snapshotWindow: false })),
        );
        const fetchColdSnapshot = Effect.gen(function* () {
          const initial = yield* SubscriptionRef.get(state);
          if (Option.isSome(initial.data) || initial.status === "deleted") {
            return Option.none<OrchestrationV2ThreadDetailSnapshot>();
          }
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          );
          return yield* snapshotLoader.load(
            prepared,
            threadId,
            options?.snapshotWindow === undefined
              ? undefined
              : { maxVisibleItems: options.snapshotWindow },
          );
        });

        const [serverSupport, httpSnapshot] = yield* Effect.all(
          [fetchServerSupport, fetchColdSnapshot],
          { concurrency: "unbounded" },
        );
        const supportsCompletionMarker = serverSupport.completionMarker;
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);

        if (Option.isSome(httpSnapshot)) {
          yield* applyItem({
            kind: "snapshot",
            snapshotSequence: httpSnapshot.value.snapshotSequence,
            projection: httpSnapshot.value.projection,
          });
        }
        const current = yield* SubscriptionRef.get(state);

        const sequence = yield* SubscriptionRef.get(lastSequence);
        const canResume = Option.isSome(current.data);
        if (!supportsCompletionMarker && canResume) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: value.status === "deleted" ? value.status : ("live" as const),
            error: Option.none(),
          }));
        }

        return {
          threadId,
          ...(canResume ? { afterSequence: sequence } : {}),
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
          ...(serverSupport.snapshotWindow && options?.snapshotWindow !== undefined
            ? { snapshotMaxVisibleItems: options.snapshotWindow }
            : {}),
        };
      }),
      {
        onExpectedFailure: setStreamError,
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEach((item) => Queue.offer(incoming, item))),
  );
  // Coalesce bursts (catch-up replay, dense token deltas) into one projection
  // update per drain: takeAll waits for the next non-empty batch, so a lone
  // live event still applies immediately while a replay backlog folds into a
  // single render.
  yield* Effect.forkScoped(
    Effect.forever(Queue.takeAll(incoming).pipe(Effect.flatMap(applyItems))),
  );

  // "Load earlier history": swap a windowed projection for the complete one on
  // demand. The full snapshot may be slightly older than the live projection,
  // so it is merged underneath the current rows rather than replacing them.
  if (options?.snapshotWindow !== undefined) {
    const historyRequests = yield* Queue.sliding<void>(1);
    const key = threadKey({ environmentId, threadId });
    const handler = () => Queue.offerUnsafe(historyRequests, undefined);
    fullHistoryRequestHandlers.set(key, handler);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        // A replacement machine for the same thread may have registered its own
        // handler before this scope tears down; only remove our own.
        if (fullHistoryRequestHandlers.get(key) === handler) {
          fullHistoryRequestHandlers.delete(key);
        }
      }),
    );
    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(historyRequests).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const current = yield* SubscriptionRef.get(state);
              if (
                Option.isNone(current.data) ||
                (current.data.value.truncatedVisibleItemCount ?? 0) === 0
              ) {
                return;
              }
              const prepared = yield* SubscriptionRef.get(supervisor.prepared);
              if (Option.isNone(prepared)) return;
              const full = yield* snapshotLoader.load(prepared.value, threadId);
              if (Option.isNone(full)) return;
              const latest = yield* SubscriptionRef.get(state);
              if (Option.isNone(latest.data) || latest.status === "deleted") return;
              yield* setThread(
                mergeOrchestrationV2FullHistory(latest.data.value, full.value.projection),
              );
            }),
          ),
        ),
      ),
    );
  }

  yield* Effect.addFinalizer(() =>
    Effect.all([SubscriptionRef.get(state), SubscriptionRef.get(lastSequence)]).pipe(
      Effect.flatMap(([current, snapshotSequence]) =>
        Option.match(current.data, {
          onNone: () => Effect.void,
          onSome: (projection) =>
            shouldPersistThread(projection)
              ? persist({ snapshotSequence, projection })
              : Effect.void,
        }),
      ),
    ),
  );

  return state;
});

export function threadStateChanges(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
  options?: EnvironmentThreadStateOptions,
) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentThreadState(threadId, options).pipe(Effect.map(SubscriptionRef.changes)),
    ),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader | R,
    E
  >,
  options?: EnvironmentThreadStateOptions,
) {
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    return runtime
      .atom(threadStateChanges(environmentId, threadId, options), {
        initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
      })
      .pipe(
        Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-thread-state:${key}`),
      );
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadDetail.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
