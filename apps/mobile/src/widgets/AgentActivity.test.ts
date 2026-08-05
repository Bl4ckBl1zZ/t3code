import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@expo/ui/swift-ui", () => ({
  HStack: "HStack",
  Image: "Image",
  Spacer: "Spacer",
  Text: "Text",
  VStack: "VStack",
  ZStack: "ZStack",
}));

vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  activityBackgroundTint: (value: unknown) => ({ activityBackgroundTint: value }),
  font: (value: unknown) => value,
  foregroundStyle: (value: unknown) => value,
  frame: (value: unknown) => value,
  layoutPriority: (value: unknown) => value,
  lineLimit: (value: unknown) => value,
  padding: (value: unknown) => value,
  resizable: (value: unknown) => value,
  widgetURL: (value: unknown) => ({ widgetURL: value }),
}));

vi.mock("expo-widgets", () => ({
  createLiveActivity: vi.fn((name: string, layout: unknown) => ({ layout, name })),
}));

import {
  AgentActivity,
  type AgentActivityProps,
  type AgentActivityRowProps,
} from "./AgentActivity";

function makeRow(overrides: Partial<AgentActivityRowProps>): AgentActivityRowProps {
  return {
    environmentId: "env-1",
    threadId: "thread-1",
    projectTitle: "Project",
    threadTitle: "Thread",
    modelTitle: "gpt-5.4",
    phase: "running",
    status: "Working",
    updatedAt: "2026-05-25T13:07:00.000Z",
    deepLink: "/threads/env-1/thread-1",
    ...overrides,
  };
}

const props = {
  title: "T3 Code",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: "2026-05-25T13:07:00.000Z",
  activities: [],
} satisfies AgentActivityProps;

const environment = {
  colorScheme: "dark",
  isLuminanceReduced: false,
} as const;

const lightEnvironment = {
  colorScheme: "light",
  isLuminanceReduced: false,
} as const;

describe("AgentActivity widget layout", () => {
  it("tints each row by its own phase using the web sidebar's dark palette", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_approval", status: "Approval" }),
        ],
      },
      environment as never,
    );
    // The banner escalates to the blocked row alone, so the per-phase palette
    // is asserted on the expanded island, which keeps the full row list.
    const expanded = JSON.stringify(layout.expandedBottom);
    expect(expanded).toContain("#7dd3fc"); // sky-300: running
    expect(expanded).toContain("#fcd34d"); // amber-300: waiting_for_approval
  });

  it("switches to the web sidebar's light palette when the scheme is light", () => {
    // macOS (iPhone Mirroring / Mac notification center) renders the activity
    // on a light background; the dark-material palette is illegible there.
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_approval", status: "Approval" }),
        ],
      },
      lightEnvironment as never,
    );
    const expanded = JSON.stringify(layout.expandedBottom);
    expect(expanded).toContain("#0284c7"); // sky-600: running
    expect(expanded).toContain("#d97706"); // amber-600: waiting_for_approval
    expect(expanded).not.toContain("#7dd3fc");
    expect(expanded).not.toContain("#fcd34d");
  });

  it("orders rows attention-first in the expanded island", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({ threadTitle: "Working thread" }),
          makeRow({
            threadId: "thread-2",
            threadTitle: "Blocked thread",
            phase: "waiting_for_approval",
            status: "Approval",
          }),
        ],
      },
      environment as never,
    );
    const expanded = JSON.stringify(layout.expandedBottom);
    expect(expanded.indexOf("Blocked thread")).toBeGreaterThan(-1);
    expect(expanded.indexOf("Blocked thread")).toBeLessThan(expanded.indexOf("Working thread"));
  });

  it("summarizes the attention count in the banner header when nothing is blocked", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 3,
        activities: [makeRow({}), makeRow({ threadId: "thread-2" })],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("3 active agents");
  });

  it("escalates the banner to a single hero row when an agent is blocked", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 3,
        activities: [
          makeRow({ threadTitle: "Working thread" }),
          makeRow({ threadId: "thread-3", threadTitle: "Second working thread" }),
          makeRow({
            threadId: "thread-2",
            threadTitle: "Blocked thread",
            phase: "waiting_for_approval",
            status: "Approval",
          }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("Waiting on you");
    expect(banner).toContain("Blocked thread");
    // The rest of the fleet is demoted to a count rather than listed.
    expect(banner).not.toContain("Working thread");
    expect(banner).toContain("+2 other agents running");
    // A live-updating relative date replaces the frozen timestamp.
    expect(banner).toContain('"dateStyle":"relative"');
    // The whole card carries the phase tint, not just the status text.
    expect(banner).toContain('"activityBackgroundTint":"#40f59e0b"');
  });

  it("keeps the row list and tints the card when work failed", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 1,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "failed", status: "Failed" }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).not.toContain("Waiting on you");
    expect(banner).toContain('"activityBackgroundTint":"#40ef4444"');
  });

  it("drops the background tint under reduced luminance", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 1,
        activities: [makeRow({ phase: "waiting_for_approval", status: "Approval" })],
      },
      { colorScheme: "dark", isLuminanceReduced: true } as never,
    );
    expect(JSON.stringify(layout.banner)).not.toContain("activityBackgroundTint");
  });

  it("uses the attention tint for the compact presentations when a row needs input", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_input", status: "Input" }),
        ],
      },
      environment as never,
    );
    expect(JSON.stringify(layout.compactLeading)).toContain("#a5b4fc"); // indigo-300
    // Glyph, not a word: the compact slot cannot grow in landscape from iOS 27.
    expect(JSON.stringify(layout.compactTrailing)).toContain("questionmark.circle.fill");
    expect(JSON.stringify(layout.compactTrailing)).not.toContain("Input");
    expect(JSON.stringify(layout.minimal)).toContain("#a5b4fc");
  });

  it("counts blocked agents in the compact trailing slot only when several are waiting", () => {
    const one = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_approval", status: "Approval" }),
        ],
      },
      environment as never,
    );
    expect(JSON.stringify(one.compactTrailing)).not.toContain('"2"');

    const many = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({ phase: "waiting_for_approval", status: "Approval" }),
          makeRow({ threadId: "thread-2", phase: "waiting_for_input", status: "Input" }),
        ],
      },
      environment as never,
    );
    expect(JSON.stringify(many.compactTrailing)).toContain('"2"');
  });

  it("deep links the watch and CarPlay card", () => {
    const layout = AgentActivity({ ...props, activities: [makeRow({})] }, environment as never);
    expect(JSON.stringify(layout.bannerSmall)).toContain(
      '"widgetURL":"t3code://threads/env-1/thread-1"',
    );
  });

  it("reduces the watch card to a glyph and a count when the system asks for less detail", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_approval", status: "Approval" }),
        ],
      },
      { ...environment, levelOfDetail: "simplified" } as never,
    );
    const small = JSON.stringify(layout.bannerSmall);
    expect(small).toContain("exclamationmark.circle.fill");
    expect(small).not.toContain("Thread");
    expect(small).not.toContain("Project");
  });

  it("scales the watch card with Dynamic Type instead of fixed point sizes", () => {
    const layout = AgentActivity({ ...props, activities: [makeRow({})] }, environment as never);
    const small = JSON.stringify(layout.bannerSmall);
    expect(small).toContain('"textStyle":"headline"');
    expect(small).toContain('"dateStyle":"relative"');
  });

  it("deep links the banner to the row that needs attention", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({
            threadId: "thread-2",
            phase: "waiting_for_approval",
            status: "Approval",
            deepLink: "/threads/env-1/thread-2",
          }),
        ],
      },
      environment as never,
    );
    expect(JSON.stringify(layout.banner)).toContain(
      '"widgetURL":"t3code://threads/env-1/thread-2"',
    );
  });

  it("deep links the banner to the first row when nothing needs attention", () => {
    const layout = AgentActivity({ ...props, activities: [makeRow({})] }, environment as never);
    expect(JSON.stringify(layout.banner)).toContain(
      '"widgetURL":"t3code://threads/env-1/thread-1"',
    );
  });

  it("omits the deep link for unsafe paths and empty aggregates", () => {
    expect(JSON.stringify(AgentActivity(props, environment as never))).not.toContain("widgetURL");
    expect(
      JSON.stringify(
        AgentActivity(
          { ...props, activities: [makeRow({ deepLink: "//evil.example" })] },
          environment as never,
        ),
      ),
    ).not.toContain("widgetURL");
  });

  it("leads with the outcome instead of a zero count when nothing is active", () => {
    const layout = AgentActivity(
      {
        ...props,
        subtitle: "Agent work completed",
        activeCount: 0,
        activities: [makeRow({ phase: "completed", status: "Done" })],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("Agent work completed");
    expect(banner).not.toContain("0 active");
    expect(banner).toContain("#6ee7b7"); // emerald-300 header tint
    expect(JSON.stringify(layout.compactTrailing)).toContain("Done");
    expect(JSON.stringify(layout.compactTrailing)).not.toContain("0 active");
    expect(JSON.stringify(layout.expandedLeading)).toContain("Done");
    expect(JSON.stringify(layout.minimal)).toContain("checkmark.circle.fill");
    expect(JSON.stringify(layout.bannerSmall)).toContain("Done");
  });

  it("reads Failed when the finished work ended in failure", () => {
    const layout = AgentActivity(
      {
        ...props,
        subtitle: "Agent work failed",
        activeCount: 0,
        activities: [makeRow({ phase: "failed", status: "Failed" })],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("Agent work failed");
    expect(banner).toContain("#fca5a5"); // red-300 header tint
    expect(JSON.stringify(layout.compactTrailing)).toContain("Failed");
    expect(JSON.stringify(layout.expandedLeading)).toContain("Failed");
    expect(JSON.stringify(layout.minimal)).toContain("xmark.octagon.fill");
  });

  it("lets a failure dominate mixed finished outcomes across every presentation", () => {
    const layout = AgentActivity(
      {
        ...props,
        // The server subtitle keys off the newest terminal row (completed
        // here); the layout must still read Failed everywhere so the header
        // text never disagrees with the tint, count slots, or minimal glyph.
        subtitle: "Agent work completed",
        activeCount: 0,
        activities: [
          makeRow({ phase: "completed", status: "Done" }),
          makeRow({ threadId: "thread-2", phase: "failed", status: "Failed" }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("Agent work failed");
    expect(banner).not.toContain("Agent work completed");
    expect(banner).toContain("#fca5a5"); // red-300 header tint
    expect(JSON.stringify(layout.compactTrailing)).toContain("Failed");
    expect(JSON.stringify(layout.expandedLeading)).toContain("Failed");
    expect(JSON.stringify(layout.minimal)).toContain("xmark.octagon.fill");
  });

  it("renders up to five rows in the banner", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 6,
        activities: [1, 2, 3, 4, 5, 6].map((n) =>
          makeRow({ threadId: `t${n}`, threadTitle: `Thread ${n}` }),
        ),
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    for (const visible of [1, 2, 3, 4, 5]) {
      expect(banner).toContain(`Thread ${visible}`);
    }
    expect(banner).not.toContain("Thread 6");
  });
});
