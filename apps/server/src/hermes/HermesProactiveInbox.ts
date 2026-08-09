import {
  HermesProactiveInboxError,
  type HermesProactiveInboxSnapshot,
  type HermesProactiveMarkNotificationsInput,
  type HermesProactiveMarkNotificationsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  subscribeBeforeSnapshot,
  type SnapshotSubscription,
} from "../utils/subscribeBeforeSnapshot.ts";
import {
  hermesProactiveSourceId,
  HermesProactiveEventRepository,
} from "./HermesProactiveEventRepository.ts";

/**
 * How long a drain worker holds an outbox entry. Delivery is a local write, so
 * the lease only has to outlive one transaction; it exists so a worker that
 * dies mid-flight releases the entry instead of stranding it in `processing`.
 */
const DELIVERY_LEASE = Duration.seconds(30);

/**
 * Delivery writes two rows in the same database T3 is already using. Failing
 * that repeatedly means something is broken rather than busy, so the backoff
 * stays short and the ceiling low: five tries, then the entry is dead-lettered
 * and surfaced in the snapshot instead of retrying forever in silence.
 */
const MAX_DELIVERY_ATTEMPTS = 5;
const DELIVERY_RETRY_BASE = Duration.seconds(5);

/**
 * Catches entries whose retry became available while nothing new arrived. The
 * wake queue covers every ordinary case; this is the floor under it.
 */
export const DELIVERY_SWEEP_INTERVAL = Duration.minutes(1);

export interface HermesWitnessedRun {
  readonly providerInstanceId: string;
  readonly profileKey: string;
  /**
   * Stable across re-deliveries of the same run. A gateway run id when Hermes
   * supplied one; otherwise the caller's derived identity.
   */
  readonly runIdentity: string;
  readonly eventKind: string;
  readonly title: string;
  readonly body: string;
  readonly threadId: string | null;
  readonly projectId: string | null;
  readonly occurredAt: string;
}

export interface HermesNotificationDrainReceipt {
  readonly delivered: number;
  readonly retried: number;
  readonly deadLettered: number;
}

export interface HermesProactiveInboxShape {
  /**
   * Records a Hermes run nobody in T3 asked for and queues its notification.
   * Never fails the caller: a witnessed run has already reached the thread
   * transcript, and losing its badge must not take the run down with it.
   */
  readonly witness: (run: HermesWitnessedRun) => Effect.Effect<void>;
  readonly snapshot: Effect.Effect<HermesProactiveInboxSnapshot, HermesProactiveInboxError>;
  readonly subscribe: Effect.Effect<
    SnapshotSubscription<HermesProactiveInboxSnapshot>,
    HermesProactiveInboxError,
    Scope.Scope
  >;
  readonly mark: (
    input: HermesProactiveMarkNotificationsInput,
  ) => Effect.Effect<HermesProactiveMarkNotificationsResult, HermesProactiveInboxError>;
  /**
   * Drains the outbox until nothing is claimable and returns what happened.
   * The background fiber calls this on every wake; tests call it directly so
   * they can assert on a receipt instead of waiting.
   */
  readonly drain: Effect.Effect<HermesNotificationDrainReceipt>;
}

/**
 * The one place a Hermes run that started without a T3 turn becomes something
 * a client can see outside the thread it landed in.
 *
 * The default implementation drops everything, which keeps adapters and their
 * tests free of a database. The live layer is provided alongside the proactive
 * repository so the server, the ws layer, and the Hermes adapter all share one
 * instance.
 */
export class HermesProactiveInbox extends Context.Reference<HermesProactiveInboxShape>(
  "t3/hermes/HermesProactiveInbox",
  {
    defaultValue: (): HermesProactiveInboxShape => ({
      witness: () => Effect.void,
      snapshot: Effect.succeed({ notifications: [], unreadCount: 0, deadLetterCount: 0 }),
      subscribe: Effect.succeed({
        latest: { notifications: [], unreadCount: 0, deadLetterCount: 0 },
        changes: Stream.never,
      }),
      mark: () =>
        Effect.succeed({
          updated: 0,
          snapshot: { notifications: [], unreadCount: 0, deadLetterCount: 0 },
        }),
      drain: Effect.succeed({ delivered: 0, retried: 0, deadLettered: 0 }),
    }),
  },
) {}

const inboxError = (operation: string, message: string) =>
  new HermesProactiveInboxError({ operation, message });

/**
 * Titles the notification for a run Hermes executed on its own schedule. The
 * thread title is not available here, so the job's own words are used: the
 * prompt a cron job carries is what the user typed when they scheduled it.
 */
export function describeWitnessedRun(input: {
  readonly jobName: string | null;
  readonly missed: boolean;
}): string {
  const subject = input.jobName === null ? "A scheduled Hermes job" : `“${input.jobName}”`;
  return input.missed ? `${subject} ran while T3 was closed` : `${subject} finished a run`;
}

export interface HermesProactiveInboxOptions {
  /**
   * Forks the drain worker into the calling scope. Tests turn it off so they
   * can drive `drain` themselves and assert on its receipt.
   */
  readonly deliveryWorker?: boolean;
}

export const make = Effect.fn("HermesProactiveInbox.make")(function* (
  options: HermesProactiveInboxOptions = {},
) {
  const repository = yield* HermesProactiveEventRepository;
  const changes = yield* PubSub.sliding<HermesProactiveInboxSnapshot>(1);
  const publishMutex = yield* Semaphore.make(1);
  const wake = yield* Queue.sliding<void>(1);
  const workerId = `hermes-inbox:${process.pid}`;

  const snapshot = repository
    .inboxSnapshot()
    .pipe(Effect.mapError(() => inboxError("snapshot", "Could not read the Hermes inbox.")));

  const publish = publishMutex.withPermits(1)(
    snapshot.pipe(
      Effect.flatMap((next) => PubSub.publish(changes, next)),
      // A snapshot that cannot be read is worth a log, not a crashed worker.
      Effect.catch((error) =>
        Effect.logWarning("hermes.inbox.publish-failed", { detail: error.message }),
      ),
    ),
  );

  const deliverOne = Effect.fn("HermesProactiveInbox.deliverOne")(function* (receipt: {
    delivered: number;
    retried: number;
    deadLettered: number;
  }) {
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const claimed = yield* repository.claimNotification({
      workerId,
      now: nowIso,
      leaseExpiresAt: DateTime.formatIso(DateTime.addDuration(now, DELIVERY_LEASE)),
    });
    if (Option.isNone(claimed)) return false;
    const entry = claimed.value;
    const delivered = yield* repository
      .deliverInApp({ outboxId: entry.outboxId, workerId, now: nowIso })
      .pipe(Effect.result);
    if (delivered._tag === "Success" && delivered.success) {
      receipt.delivered += 1;
      return true;
    }
    const errorCode =
      delivered._tag === "Failure" ? delivered.failure.operation : "lease_lost_or_stale";
    // A lost fence is not a delivery failure — another worker owns the entry
    // now — so it is left alone rather than pushed toward the dead letter.
    if (delivered._tag === "Success") return true;
    if (entry.attemptCount >= MAX_DELIVERY_ATTEMPTS) {
      const buried = yield* repository
        .deadLetterNotification({ outboxId: entry.outboxId, workerId, now: nowIso, errorCode })
        .pipe(Effect.orElseSucceed(() => false));
      if (buried) receipt.deadLettered += 1;
      yield* Effect.logWarning("hermes.inbox.notification-dead-lettered", {
        outboxId: entry.outboxId,
        attemptCount: entry.attemptCount,
        errorCode,
      });
      return true;
    }
    const availableAt = DateTime.formatIso(
      DateTime.addDuration(
        now,
        Duration.times(DELIVERY_RETRY_BASE, Math.max(1, entry.attemptCount)),
      ),
    );
    const retried = yield* repository
      .retryNotification({
        outboxId: entry.outboxId,
        workerId,
        now: nowIso,
        availableAt,
        errorCode,
      })
      .pipe(Effect.orElseSucceed(() => false));
    if (retried) receipt.retried += 1;
    return true;
  });

  const drain: HermesProactiveInboxShape["drain"] = Effect.gen(function* () {
    const receipt = { delivered: 0, retried: 0, deadLettered: 0 };
    // Bounded by the outbox itself: every iteration either claims an entry and
    // moves it out of the claimable set, or stops.
    let claimable = true;
    while (claimable) {
      claimable = yield* deliverOne(receipt).pipe(Effect.orElseSucceed(() => false));
    }
    if (receipt.delivered > 0 || receipt.deadLettered > 0) yield* publish;
    return receipt satisfies HermesNotificationDrainReceipt;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("hermes.inbox.drain-failed", { cause }).pipe(
        Effect.as({ delivered: 0, retried: 0, deadLettered: 0 }),
      ),
    ),
  );

  const witness: HermesProactiveInboxShape["witness"] = (run) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const recorded = yield* repository.recordWitnessedEvent({
        sourceId: hermesProactiveSourceId(run.providerInstanceId, run.profileKey),
        externalEventId: `${run.eventKind}:${run.runIdentity}`,
        eventKind: run.eventKind,
        title: run.title,
        body: run.body,
        projectId: run.projectId,
        threadId: run.threadId,
        occurredAt: run.occurredAt,
        receivedAt: now,
        gatewayRevision: null,
      });
      if (!recorded) return;
      yield* Queue.offer(wake, undefined);
    }).pipe(
      // Proactive mode being off leaves no source row to attach to, which is
      // the switch doing its job rather than a fault.
      Effect.catchCause((cause) =>
        Effect.logDebug("hermes.inbox.witness-skipped", {
          providerInstanceId: run.providerInstanceId,
          runIdentity: run.runIdentity,
          cause,
        }),
      ),
    );

  const mark: HermesProactiveInboxShape["mark"] = (input) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const updated = yield* repository.markNotifications({
        notificationIds: input.notificationIds,
        status: input.status,
        now,
      });
      if (updated > 0) yield* publish;
      return { updated, snapshot: yield* snapshot };
    }).pipe(
      Effect.mapError((error) =>
        error instanceof HermesProactiveInboxError
          ? error
          : inboxError("mark", "Could not update the Hermes notifications."),
      ),
    );

  // One consumer, so two drains never race for the same outbox entry. The
  // timer only nudges the same queue, which is what makes a retry that came
  // due during a quiet hour get picked up.
  if (options.deliveryWorker !== false) {
    yield* Queue.offer(wake, undefined).pipe(
      Effect.delay(DELIVERY_SWEEP_INTERVAL),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* Queue.take(wake).pipe(
      Effect.flatMap(() => drain),
      Effect.forever,
      Effect.forkScoped,
    );
  }

  return {
    witness,
    snapshot,
    subscribe: subscribeBeforeSnapshot(changes, snapshot, publishMutex),
    mark,
    drain,
  } satisfies HermesProactiveInboxShape;
});

export const layer = Layer.effect(HermesProactiveInbox, make());
