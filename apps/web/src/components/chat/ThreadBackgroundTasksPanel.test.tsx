import * as DateTime from "effect/DateTime";
import {
  NodeId,
  type EnvironmentId,
  type OrchestrationV2CommandExecutionItem,
  type OrchestrationV2ProjectedTurnItem,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  visibleTurnItems: vi.fn(),
}));

vi.mock("../../state/entities", () => ({
  useThreadVisibleTurnItems: (...args: ReadonlyArray<unknown>) =>
    testState.visibleTurnItems(...args),
}));

import { ThreadBackgroundTasksPanel } from "./ThreadBackgroundTasksPanel";

const ENVIRONMENT_ID = "environment:bg" as EnvironmentId;
const THREAD_ID = ThreadId.make("thread-bg");
const START = DateTime.makeUnsafe("2026-08-04T12:00:00.000Z");

function commandItem(
  overrides: Partial<OrchestrationV2CommandExecutionItem> = {},
): OrchestrationV2CommandExecutionItem {
  return {
    id: TurnItemId.make("item-1"),
    threadId: THREAD_ID,
    runId: RunId.make("run-1"),
    nodeId: NodeId.make("node-1"),
    providerThreadId: ProviderThreadId.make("pt-1"),
    providerTurnId: ProviderTurnId.make("ptn-1"),
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "waiting" as const,
    title: null,
    startedAt: START,
    completedAt: null,
    updatedAt: START,
    type: "command_execution" as const,
    input: "pnpm vitest run apps/web",
    background: true,
    taskId: "bs891h9i0",
    ...overrides,
  };
}

function projected(item: OrchestrationV2CommandExecutionItem): OrchestrationV2ProjectedTurnItem {
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
}

function render(items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>): string {
  testState.visibleTurnItems.mockReturnValue(items);
  return renderToStaticMarkup(
    <ThreadBackgroundTasksPanel environmentId={ENVIRONMENT_ID} threadId={THREAD_ID} />,
  );
}

describe("ThreadBackgroundTasksPanel", () => {
  beforeEach(() => {
    testState.visibleTurnItems.mockReset();
  });

  it("renders nothing when the thread has no live background command", () => {
    expect(render([])).toBe("");
    expect(render([projected(commandItem({ status: "completed", background: true }))])).toBe("");
    // A foreground command is not a background task even while it runs.
    expect(render([projected(commandItem({ background: false }))])).toBe("");
  });

  it("shows the command and its last line of output", () => {
    const markup = render([projected(commandItem({ output: "compiling…\n✓ 41 tests passed\n" }))]);
    expect(markup).toContain("Background Tasks");
    expect(markup).toContain("pnpm vitest run apps/web");
    expect(markup).toContain("✓ 41 tests passed");
  });

  it("says so honestly when a running command has printed nothing", () => {
    expect(render([projected(commandItem())])).toContain("no output yet");
  });

  it("folds a monitor into the command it watches instead of listing it twice", () => {
    const markup = render([
      projected(commandItem({ output: "building…\n" })),
      projected(
        commandItem({
          id: TurnItemId.make("item-2"),
          taskId: "b8zv6rtg9",
          waitKind: "monitor",
          waitingOnTaskId: "bs891h9i0",
          input: 'until grep -qE "DONE" /tmp/tasks/bs891h9i0.output; do sleep 1; done',
          timeoutMs: 120_000,
        }),
      ),
    ]);
    expect(markup.match(/<li /gu)).toHaveLength(1);
    expect(markup).toContain("the agent is waiting on it");
    expect(markup).not.toContain("Waiting on a condition");
  });

  it("gives an orphan monitor its own row with the deadline it gives up at", () => {
    const markup = render([
      projected(
        commandItem({
          waitKind: "monitor",
          waitingOnTaskId: "bs891h9i0",
          timeoutMs: 120_000,
        }),
      ),
    ]);
    expect(markup).toContain("Waiting on a condition");
    expect(markup).toContain("the agent is asleep until this passes");
    expect(markup).toContain("left");
  });

  it("caps the list and reports what it left out", () => {
    const markup = render(
      Array.from({ length: 6 }, (_unused, index) =>
        projected(
          commandItem({
            id: TurnItemId.make(`item-${index}`),
            taskId: `task-${index}`,
            input: `sleep ${index}`,
          }),
        ),
      ),
    );
    expect(markup.match(/<li /gu)).toHaveLength(4);
    expect(markup).toContain("+2 more");
  });
});
