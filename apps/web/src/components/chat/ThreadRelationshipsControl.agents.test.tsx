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
  workflowCommand: vi.fn().mockResolvedValue({ _tag: "Success" }),
  canOperateWorkflow: true,
  toast: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/orchestration", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const granted = Atom.make(true);
  const denied = Atom.make(false);
  return {
    orchestrationEnvironment: {
      v2: {
        getWorkflowScript: { label: "get-workflow-script" },
        stopWorkflow: {
          label: "stop-workflow",
          permissionAtom: () => (state.canOperateWorkflow ? granted : denied),
        },
      },
    },
  };
});
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
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
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label?: string }) =>
    command.label === "stop-workflow" ? state.workflowCommand : state.command,
}));
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
  state.workflowCommand.mockReset().mockResolvedValue({ _tag: "Success" });
  state.canOperateWorkflow = true;
  state.toast.mockClear();
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

it("stops a running Claude-native subagent through its owner, not its thread", async () => {
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
  const native = {
    ...agent,
    origin: "provider_native",
    driver: "claudeAgent",
    threadId: PARENT_ID,
    runId: "run-1",
    nativeTaskRef: { driver: "claudeAgent", nativeId: "claude-task", strength: "strong" },
    status: "running",
    completedAt: null,
  };
  state.projection = projectionWith([native]);
  await renderExpanded();
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "Stop subagent Checker" }).props.onClick(),
  );
  expect(state.command).toHaveBeenCalledWith({
    environmentId: ENVIRONMENT_ID,
    input: { threadId: PARENT_ID, subagentId: "agent" },
  });
  expect(state.navigate).not.toHaveBeenCalled();

  // Other providers' native subagents have no stop path, and neither does a
  // workflow member, which has no run of its own to stop it through.
  for (const unstoppable of [
    { ...native, driver: "codex" },
    { ...native, runId: null },
  ]) {
    await act(async () => renderer.unmount());
    state.projection = projectionWith([unstoppable]);
    await renderExpanded();
    expect(renderer.root.findAllByProps({ "aria-label": "Stop subagent Checker" })).toHaveLength(0);
  }
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

const WORKFLOW_STARTED_AT = DateTime.makeUnsafe("2026-09-21T12:00:00Z");

const coordinator = {
  id: "workflow",
  threadId: PARENT_ID,
  runId: "run-1",
  childThreadId: "workflow-chat",
  origin: "provider_native",
  driver: "claudeAgent",
  providerInstanceId: "claudeAgent",
  nativeTaskRef: { driver: "claudeAgent", nativeId: "claude-task", strength: "strong" },
  title: "Workflow coordinator",
  prompt: "Run the checkout review",
  model: null,
  status: "running",
  result: null,
  startedAt: WORKFLOW_STARTED_AT,
  completedAt: null,
  updatedAt: WORKFLOW_STARTED_AT,
  workflow: {
    name: "Checkout review",
    phases: [{ index: 0, title: "Inspect" }],
    agents: [
      {
        index: 0,
        label: "Checker",
        state: "running",
        phaseIndex: 0,
        childThreadId: "member-chat",
        startedAt: DateTime.toEpochMillis(WORKFLOW_STARTED_AT),
      },
    ],
  },
};

const coordinatorShell = (overrides: Record<string, unknown> = {}) => ({
  environmentId: ENVIRONMENT_ID,
  source: {
    id: "workflow-chat",
    title: "Subagent: Coordinator chat",
    status: "idle",
    lineage: { parentThreadId: PARENT_ID, relationshipToParent: "subagent" },
    forkedFrom: null,
    ...overrides,
  },
});

const memberShell = (id: string, environmentId: string = ENVIRONMENT_ID) => ({
  environmentId,
  source: {
    id,
    title: `Subagent: ${id}`,
    status: "completed",
    lineage: { parentThreadId: "workflow-chat", relationshipToParent: "subagent" },
    forkedFrom: null,
  },
});

const panel = <ThreadRelationshipsPanel environmentId={ENVIRONMENT_ID} threadId={PARENT_ID} />;

const buttonsLabelled = (prefix: string) =>
  renderer.root.findAll(
    (node) => node.type === "button" && String(node.props["aria-label"]).startsWith(prefix),
  );

it("stops the entire native workflow through its parent", async () => {
  state.shells = [
    coordinatorShell(),
    {
      ...childShell,
      source: {
        ...childShell.source,
        id: "worker-chat",
        title: "Subagent: Worker",
        status: "running",
        activityRunStartedAt: WORKFLOW_STARTED_AT,
      },
    },
  ];
  state.projection = projectionWith([
    coordinator,
    { ...agent, id: "worker", childThreadId: "worker-chat", status: "running", completedAt: null },
  ]);
  await renderExpanded();
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "Expand Checkout review" }).props.onClick(),
  );
  // The workflow stops as a whole; its coordinator offers no Stop of its own.
  expect(
    buttonsLabelled("Stop ")
      .map((button) => button.props["aria-label"])
      .toSorted(),
  ).toEqual(["Stop subagent Worker", "Stop workflow Checkout review"]);
  const stopButton = () =>
    renderer.root.findByProps({ "aria-label": "Stop workflow Checkout review" });
  let acknowledge!: (result: { _tag: string }) => void;
  state.workflowCommand.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  await act(async () => stopButton().props.onClick());
  expect(state.workflowCommand).toHaveBeenCalledExactlyOnceWith({
    environmentId: ENVIRONMENT_ID,
    input: { threadId: PARENT_ID, subagentId: "workflow" },
  });
  // One stop at a time, across the whole panel.
  expect(stopButton().props.disabled).toBe(true);
  expect(renderer.root.findByProps({ "aria-label": "Stop subagent Worker" }).props.disabled).toBe(
    true,
  );
  await act(async () => acknowledge({ _tag: "Success" }));
  expect(stopButton().props.disabled).toBe(false);

  state.workflowCommand.mockResolvedValueOnce({ _tag: "Failure" });
  await act(async () => stopButton().props.onClick());
  expect(state.toast).toHaveBeenCalledExactlyOnceWith({
    type: "error",
    title: "Could not stop workflow",
  });
  expect(stopButton().props.disabled).toBe(false);
  expect(state.command).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
});

it.each([
  { case: "completed", patch: { status: "completed" } },
  { case: "failed", patch: { status: "failed" } },
  { case: "interrupted", patch: { status: "interrupted" } },
  { case: "waiting", patch: { status: "waiting" } },
  { case: "Codex", patch: { driver: "codex" } },
  { case: "app-owned", patch: { origin: "app_owned" } },
  { case: "unauthorized", patch: {}, denied: true },
])("offers no workflow Stop for a $case workflow", async ({ patch, denied }) => {
  state.canOperateWorkflow = denied !== true;
  state.shells = [coordinatorShell()];
  state.projection = projectionWith([{ ...coordinator, ...patch }]);
  await renderExpanded();
  expect(renderer.root.findByProps({ "aria-label": "Expand Checkout review" })).toBeDefined();
  expect(buttonsLabelled("Stop ")).toHaveLength(0);
});

it("opens each member's chat from its phase once the chat exists here", async () => {
  const phases = ["Inspect", "Improve", "Verify"].map((title, index) => ({ index, title }));
  const memberStates = ["completed", "completed", "failed", "completed", "completed", "running"];
  const members = [...memberStates, "completed"].map((memberState, index) => ({
    index,
    label: `Member ${index}`,
    state: memberState,
    // The last member reports no phase and sits directly under the workflow.
    ...(index < 6 ? { phaseIndex: Math.floor(index / 2) } : {}),
    childThreadId: `member-chat-${index}`,
    // Staggered starts, so a phase spans longer than either member's own run.
    startedAt: DateTime.toEpochMillis(WORKFLOW_STARTED_AT) + index * 1000,
    ...(memberState === "running" ? {} : { durationMs: 5000 }),
  }));
  const project = (agents: typeof members) =>
    projectionWith([{ ...coordinator, workflow: { name: "Checkout review", phases, agents } }]);
  state.projection = project(members);
  // The same chats in another environment are not openable from here.
  state.shells = [
    coordinatorShell(),
    ...members.map((member) => memberShell(member.childThreadId, "other")),
  ];
  await renderExpanded();
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "Expand Checkout review" }).props.onClick(),
  );
  const memberButtons = () => buttonsLabelled("Open Member");
  const phaseButtons = () =>
    renderer.root.findAll(
      (node) => node.type === "button" && String(node.props["aria-label"]).includes(" phase, "),
    );
  // Only the running phase starts open, beside the unphased member.
  expect(phaseButtons().map((button) => button.props["aria-label"])).toEqual([
    "Expand Inspect phase, done",
    "Expand Improve phase, failed",
    "Collapse Verify phase, running",
  ]);
  expect(memberButtons()).toHaveLength(3);
  expect(text()).toContain("1 / 2 agents");
  for (const phase of phaseButtons().slice(0, 2)) await act(async () => phase.props.onClick());
  expect(memberButtons()).toHaveLength(7);
  // Members 0 and 1 start a second apart and run 5s each, so Inspect took 6s.
  expect(text()).toContain("6s");
  for (const button of memberButtons()) {
    expect(button.props.disabled).toBe(true);
    await act(async () => button.props.onClick());
  }
  expect(state.navigate).not.toHaveBeenCalled();

  // The roster arrives before the member chats do.
  state.shells = [
    coordinatorShell(),
    ...members.map((member) => memberShell(member.childThreadId)),
  ];
  await act(async () => renderer.update(cloneElement(panel)));
  for (const member of members) {
    const button = renderer.root.findByProps({ "aria-label": `Open ${member.label} chat` });
    expect(button.props.disabled).toBe(false);
    await act(async () => button.props.onClick());
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: member.childThreadId },
    });
  }

  // A phase the user closed stays closed when it starts running again.
  await act(async () => phaseButtons()[0]!.props.onClick());
  expect(memberButtons()).toHaveLength(5);
  state.projection = project(
    members.map((member) => (member.index === 0 ? { ...member, state: "running" } : member)),
  );
  await act(async () => renderer.update(cloneElement(panel)));
  expect(memberButtons()).toHaveLength(5);
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "Collapse Checkout review" }).props.onClick(),
  );
  expect(memberButtons()).toHaveLength(0);
});

it("groups a workflow by its run status instead of its coordinator chat", async () => {
  // The coordinator chat settled while the run it started still works.
  state.shells = [coordinatorShell({ status: "completed", latestRunId: "chat-run" })];
  state.projection = projectionWith([coordinator]);
  await renderExpanded();
  expect(text()).toContain("1 working");
  expect(text()).toContain("Checkout review");
  expect(text()).not.toContain("Coordinator chat");

  // Once the run settles, members it left unfinished settle with it.
  state.projection = projectionWith([
    {
      ...coordinator,
      status: "completed",
      completedAt: DateTime.makeUnsafe("2026-09-21T12:10:00Z"),
    },
  ]);
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("1 done");
  expect(text()).toContain("10m");
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "Expand Checkout review" }).props.onClick(),
  );
  const phase = renderer.root.findByProps({ "aria-label": "Expand Inspect phase, done" });
  await act(async () => phase.props.onClick());
  expect(text()).toContain("Checker Done");
});
