import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  shells: [] as ReadonlyArray<{ environmentId: string; source: unknown }>,
}));

vi.mock("../../state/entities", () => ({
  useThreadProjection: () => null,
  useThreadShells: () => testState.shells,
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots: [] }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

const ENVIRONMENT_ID = "environment:relationships" as EnvironmentId;
const CURRENT_THREAD_ID = "thread:current" as ThreadId;

function subagentShell(input: { readonly id: string; readonly status: string }): {
  environmentId: string;
  source: unknown;
} {
  const source = {
    id: input.id as ThreadId,
    title: `Subagent: worker ${input.id}`,
    status: input.status,
    lineage: { parentThreadId: CURRENT_THREAD_ID, relationshipToParent: "subagent" },
    forkedFrom: null,
  } as unknown as OrchestrationV2ThreadShell;
  return { environmentId: ENVIRONMENT_ID, source };
}

function renderPanel(): string {
  return renderToStaticMarkup(
    <ThreadRelationshipsPanel environmentId={ENVIRONMENT_ID} threadId={CURRENT_THREAD_ID} />,
  );
}

describe("ThreadRelationshipsPanel", () => {
  beforeEach(() => {
    testState.shells = [];
  });

  it("collapses subagents into a summary row with working and done counts", () => {
    testState.shells = [
      ...Array.from({ length: 6 }, (_, index) =>
        subagentShell({ id: `thread:working-${index}`, status: "running" }),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        subagentShell({ id: `thread:done-${index}`, status: "completed" }),
      ),
    ];
    const markup = renderPanel();
    expect(markup).toContain("Subagents");
    expect(markup).toContain("6 working");
    expect(markup).toContain("3 done");
    expect(markup).toContain("data-thread-relationships-subagents-toggle");
    expect(markup).toContain('aria-expanded="false"');
    // Individual subagent rows stay hidden until the accordion expands.
    expect(markup).not.toContain("worker thread:working-0");
  });

  it("labels an all-done group without a working count", () => {
    testState.shells = [
      subagentShell({ id: "thread:done-a", status: "completed" }),
      subagentShell({ id: "thread:done-b", status: "completed" }),
    ];
    const markup = renderPanel();
    expect(markup).toContain("2 done");
    expect(markup).not.toContain("0 working");
  });

  it("surfaces failed subagents in the summary", () => {
    testState.shells = [
      subagentShell({ id: "thread:working-a", status: "running" }),
      subagentShell({ id: "thread:failed-a", status: "failed" }),
    ];
    const markup = renderPanel();
    expect(markup).toContain("1 working");
    expect(markup).toContain("1 failed");
  });

  it("keeps the parent lineage row visible outside the subagents accordion", () => {
    const parentSource = {
      id: CURRENT_THREAD_ID,
      title: "Subagent: current worker",
      status: "running",
      lineage: { parentThreadId: "thread:parent" as ThreadId, relationshipToParent: "subagent" },
      forkedFrom: null,
    } as unknown as OrchestrationV2ThreadShell;
    const parentShell = {
      id: "thread:parent" as ThreadId,
      title: "Parent thread",
      status: "running",
      lineage: { parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
    } as unknown as OrchestrationV2ThreadShell;
    testState.shells = [
      { environmentId: ENVIRONMENT_ID, source: parentSource },
      { environmentId: ENVIRONMENT_ID, source: parentShell },
    ];
    const markup = renderPanel();
    expect(markup).toContain("Lineage");
    expect(markup).toContain("Parent thread");
    expect(markup).not.toContain("data-thread-relationships-subagents-toggle");
  });
});
