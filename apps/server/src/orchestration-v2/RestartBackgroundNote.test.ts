import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  cancelledTurnItemWork,
  pendingRestartCancelledBackgroundWork,
  restartCancelledBackgroundWorkNote,
  mergeRestartCancelledBackgroundWork,
} from "./RestartBackgroundNote.ts";

const claudeThread = ProviderThreadId.make("provider-thread:claude");
const codexThread = ProviderThreadId.make("provider-thread:codex");
const lost = [{ kind: "subagent" as const, label: "Background subagent test" }];

function run(
  ordinal: number,
  providerThreadId: ProviderThreadId,
  extra: Partial<OrchestrationV2Run> = {},
): OrchestrationV2Run {
  return {
    id: RunId.make(`run:${ordinal}`),
    ordinal,
    providerThreadId,
    userMessageId: MessageId.make(`message:${ordinal}`),
    activeAttemptId: RunAttemptId.make(`attempt:${ordinal}`),
    status: "completed",
    ...extra,
  } as OrchestrationV2Run;
}

const turnFor = (source: OrchestrationV2Run) => ({
  runAttemptId: source.activeAttemptId,
  providerThreadId: source.providerThreadId!,
  status: "completed" as const,
});

const pendingFor = (
  target: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
  options: {
    readonly compactionMessageIds?: ReadonlySet<string>;
    readonly continuationMessageIds?: ReadonlySet<string>;
  } = {},
) =>
  pendingRestartCancelledBackgroundWork({
    runs,
    providerTurns: runs.filter((source) => source.id !== target.id).map(turnFor),
    compactionMessageIds: options.compactionMessageIds ?? new Set(),
    continuationMessageIds: options.continuationMessageIds ?? new Set(),
    run: target,
    runAttemptIds: target.activeAttemptId === null ? [] : [target.activeAttemptId],
  });

it("keeps the note for the provider thread that lost the work across a provider switch", () => {
  const root = run(1, claudeThread, { restartCancelledBackgroundWork: lost });
  const onCodex = run(2, codexThread);
  const backOnClaude = run(3, claudeThread);

  // Codex never lost the work, so it neither receives nor consumes the note.
  assert.deepEqual(pendingFor(onCodex, [root, onCodex]), []);
  assert.deepEqual(pendingFor(backOnClaude, [root, onCodex, backOnClaude]), lost);
  // Once Claude was told, later Claude turns are not.
  const later = run(4, claudeThread);
  assert.deepEqual(pendingFor(later, [root, onCodex, backOnClaude, later]), []);
});

it("skips compactions and restart continuations, which neither carry nor deliver the note", () => {
  const root = run(1, claudeThread, { restartCancelledBackgroundWork: lost });
  const compaction = run(2, claudeThread);
  const continuation = run(3, claudeThread);
  const next = run(4, claudeThread);
  const runs = [root, compaction, continuation, next];
  const options = {
    compactionMessageIds: new Set([String(compaction.userMessageId)]),
    continuationMessageIds: new Set([String(continuation.userMessageId)]),
  };

  assert.deepEqual(pendingFor(compaction, runs, options), []);
  assert.deepEqual(pendingFor(continuation, runs, options), []);
  // Neither reached the model with the note, so the next prompted turn still owes it.
  assert.deepEqual(pendingFor(next, runs, options), lost);
});

it("bounds the note so it cannot crowd out the turn's context", () => {
  const work = Array.from({ length: 25 }, (_, index) => ({
    kind: "shell" as const,
    label: `sleep ${index}`,
  }));
  const note = restartCancelledBackgroundWorkNote(work);
  assert.lengthOf(note.split("\n"), 12);
  assert.isTrue(note.endsWith("- and 15 more"));
  const command = cancelledTurnItemWork({
    type: "command_execution",
    input: "x".repeat(10_000),
    title: null,
  } as never);
  assert.isAtMost(command?.label.length ?? 0, 160);
});

it("names a monitor command as a monitor", () => {
  const monitor = cancelledTurnItemWork({
    type: "command_execution",
    input: "wait for build",
    title: null,
    waitKind: "monitor",
  } as never);
  assert.equal(monitor?.kind, "monitor");
  assert.equal(monitor?.label, "wait for build");
});

it("keeps separate cancelled tasks that share a kind and label", () => {
  const first = { kind: "shell" as const, label: "sleep 20", id: "item-1" };
  const second = { kind: "shell" as const, label: "sleep 20", id: "item-2" };
  const merged = mergeRestartCancelledBackgroundWork([first], [second, first]);
  assert.deepEqual(merged, [first, second]);
  // Rows recorded before ids existed still collapse by kind + label.
  const legacy = { kind: "shell" as const, label: "sleep 20" };
  assert.lengthOf(mergeRestartCancelledBackgroundWork([legacy], [legacy]), 1);
});

it("does not repeat the note when a steer restarts the run on a new attempt", () => {
  const root = run(1, claudeThread, { restartCancelledBackgroundWork: lost });
  const steered = run(2, claudeThread, {
    activeAttemptId: RunAttemptId.make("attempt:2b"),
  });
  const firstAttempt = RunAttemptId.make("attempt:2a");
  const pending = (runAttemptIds: ReadonlyArray<RunAttemptId>, delivered: boolean) =>
    pendingRestartCancelledBackgroundWork({
      runs: [root, steered],
      providerTurns: [
        turnFor(root),
        ...(delivered
          ? [
              {
                runAttemptId: firstAttempt,
                providerThreadId: claudeThread,
                status: "completed" as const,
              },
            ]
          : []),
      ],
      compactionMessageIds: new Set(),
      continuationMessageIds: new Set(),
      run: steered,
      runAttemptIds,
    });

  // The first attempt reached the provider with the note; its replacement must not repeat it.
  assert.deepEqual(pending([firstAttempt, RunAttemptId.make("attempt:2b")], true), []);
  // A first attempt that never reached the provider did not deliver it.
  assert.deepEqual(pending([firstAttempt, RunAttemptId.make("attempt:2b")], false), lost);
});

it("delivers a resumed queued run's note even after a higher-ordinal run", () => {
  // Run 3 ran ahead of held run 2; run 2 then resumed and lost background
  // work in a second restart.
  const ranFirst = run(3, claudeThread, {
    completedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
  });
  const resumed = run(2, claudeThread, {
    completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00.000Z"),
    restartCancelledBackgroundWork: lost,
  });
  const next = run(4, claudeThread);
  assert.deepEqual(pendingFor(next, [resumed, ranFirst, next]), lost);
});

it("counts only a completed turn as delivering the note", () => {
  const root = run(1, claudeThread, { restartCancelledBackgroundWork: lost });
  const cut = run(2, claudeThread);
  const next = run(3, claudeThread);
  const pending = (status: "running" | "completed") =>
    pendingRestartCancelledBackgroundWork({
      runs: [root, cut, next],
      providerTurns: [turnFor(root), { ...turnFor(cut), status }],
      compactionMessageIds: new Set(),
      continuationMessageIds: new Set(),
      run: next,
      runAttemptIds: [next.activeAttemptId!],
    });
  // A turn cut before it completed may never have accepted the prompt.
  assert.deepEqual(pending("running"), lost);
  assert.deepEqual(pending("completed"), []);
});
