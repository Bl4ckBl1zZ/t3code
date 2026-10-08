import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  shells: [] as unknown[],
  navigate: vi.fn(),
  command: vi.fn().mockResolvedValue({ _tag: "Success" }),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/entities", () => ({
  useThreadProjection: () => ({ projection: state.projection }),
  useThreadShells: () => state.shells,
  useProjects: () => [],
}));
vi.mock("../../state/providerEntries", () => ({
  useProviderEntryByInstanceId: () => new Map(),
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots: [] }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.command }));
vi.mock("../ThreadHoverCard", () => ({ ThreadHoverCardPopup: () => null }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));

import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

const ENVIRONMENT_ID = EnvironmentId.make("environment:relationships");
const PARENT_ID = ThreadId.make("parent");

const childShell = {
  environmentId: ENVIRONMENT_ID,
  source: {
    id: "child",
    title: "Subagent: Checker",
    status: "completed",
    lineage: { parentThreadId: PARENT_ID, relationshipToParent: "subagent" },
    forkedFrom: null,
  },
};

const agent = {
  id: "agent",
  childThreadId: "child",
  origin: "app_owned",
  driver: "codex",
  providerInstanceId: "codex",
  title: "Checker",
  prompt: "Check the change",
  model: "gpt-5.4",
  status: "completed",
  result: "All checks passed",
  startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
  completedAt: DateTime.makeUnsafe("2026-09-16T12:02:15Z"),
};

function projectionWith(subagents: ReadonlyArray<unknown>) {
  return {
    thread: {
      id: PARENT_ID,
      lineage: { parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
    },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents,
  };
}

let renderer: ReactTestRenderer;

const text = () =>
  renderer.root
    .findAll((node) => typeof node.type === "string")
    .flatMap((node) => node.children.filter((child) => typeof child === "string"))
    .join(" ")
    .replace(/\s+/g, " ");

async function renderExpanded() {
  await act(async () => {
    renderer = create(
      <ThreadRelationshipsPanel environmentId={ENVIRONMENT_ID} threadId={PARENT_ID} />,
    );
  });
  await act(async () =>
    renderer.root
      .find((node) => node.props["data-thread-relationships-subagents-toggle"] === true)
      .props.onClick(),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
  state.projection = null;
  state.shells = [];
  state.command.mockClear();
  state.navigate.mockClear();
});

it("shows a timed subagent's compact time instead of its status label", async () => {
  state.shells = [childShell];
  state.projection = projectionWith([agent]);
  await renderExpanded();
  // The orb carries status, so the row's one trailing item is the time.
  expect(text()).toContain("Checker 2m");
  expect(text()).not.toContain("Done");
});

it("stops a running app-owned subagent from its row without opening its thread", async () => {
  state.shells = [
    {
      ...childShell,
      source: {
        ...childShell.source,
        status: "running",
        activityRunStartedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
      },
    },
  ];
  state.projection = projectionWith([{ ...agent, status: "running", completedAt: null }]);
  await renderExpanded();
  // The running time stays the row's trailing item; Stop takes its place on hover.
  expect(text()).toMatch(/Checker \d/);
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "Stop subagent Checker" }).props.onClick(),
  );
  expect(state.command).toHaveBeenCalledWith({
    environmentId: ENVIRONMENT_ID,
    input: { threadId: "child" },
  });
  expect(state.navigate).not.toHaveBeenCalled();
});

it("offers no Stop for a settled subagent", async () => {
  state.shells = [childShell];
  state.projection = projectionWith([agent]);
  await renderExpanded();
  expect(renderer.root.findAllByProps({ "aria-label": "Stop subagent Checker" })).toHaveLength(0);
});

it("keeps the status label for a failed subagent", async () => {
  state.shells = [{ ...childShell, source: { ...childShell.source, status: "failed" } }];
  state.projection = projectionWith([{ ...agent, status: "failed" }]);
  await renderExpanded();
  expect(text()).toContain("Failed");
  expect(text()).not.toContain("2m");
});
