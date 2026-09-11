import { describe, expect, it } from "@effect/vitest";
import { RunId, RuntimeRequestId, type ThreadPullRequestLink } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  isAutoSettlementCandidate,
  resolveAutoSettlementAt,
  type SettlementThread,
  type SettlementPullRequest,
} from "./ThreadSettlementPolicy.ts";

const date = DateTime.makeUnsafe;
const now = date("2026-09-11T12:00:00Z");
const before = date("2026-09-01T12:00:00Z");
const thread = (overrides: Partial<SettlementThread> = {}): SettlementThread => ({
  createdAt: before,
  latestUserMessageAt: before,
  latestRunRequestedAt: before,
  latestRunStartedAt: before,
  latestRunCompletedAt: before,
  status: "completed",
  activeRunId: null,
  pendingRuntimeRequest: null,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  pullRequests: [],
  ...overrides,
});
const decide = (
  overrides: Partial<SettlementThread> = {},
  pr: SettlementPullRequest | null = null,
  days: number | null = 3,
  merge = true,
) =>
  resolveAutoSettlementAt({
    thread: thread(overrides),
    pullRequest: pr,
    now,
    autoSettleAfterDays: days,
    autoSettleOnMerge: merge,
  });
const link = (state: "open" | "merged" | "closed", number = 1): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "org/repo",
  number,
  url: `https://github.com/org/repo/pull/${number}`,
  source: "manual",
  linkedAt: "2026-09-01T12:00:00Z",
  stack: null,
  snapshot: {
    state,
    title: "Change",
    headBranch: `feature/${number}`,
    baseBranch: "main",
    isDraft: false,
    updatedAt: "2026-09-11T12:00:00Z",
    syncedAt: "2026-09-11T12:00:00Z",
    mergedAt: state === "merged" ? "2026-09-10T12:00:00Z" : null,
    closedAt: state === "closed" ? "2026-09-10T12:00:00Z" : null,
  },
});

describe("V2 automatic settlement policy", () => {
  it("persists actual activity time and keeps never-used threads active", () => {
    expect(decide()).toEqual(before);
    expect(
      decide({
        latestUserMessageAt: null,
        latestRunRequestedAt: null,
        latestRunStartedAt: null,
        latestRunCompletedAt: null,
      }),
    ).toBeNull();
    expect(decide({}, null, null)).toBeNull();
    expect(decide({ latestRunCompletedAt: date("2026-09-08T12:00:00Z") })).toBeNull();
  });
  it("ignores changed PR metadata after resumed work and requires terminal timestamps", () => {
    expect(
      decide(
        { latestUserMessageAt: now },
        { state: "merged", mergedAt: "2026-09-10T12:00:00Z" },
        null,
      ),
    ).toBeNull();
    expect(decide({}, { state: "merged" }, null)).toBeNull();
    expect(decide({}, { state: "merged", mergedAt: "invalid" }, null)).toBeNull();
    expect(decide({}, { state: "merged", mergedAt: "2026-09-10T12:00:00Z" }, null)).toEqual(before);
  });
  it("honors merge opt-out while closed requests remain terminal", () => {
    expect(
      decide({}, { state: "merged", mergedAt: "2026-09-10T12:00:00Z" }, null, false),
    ).toBeNull();
    expect(decide({}, { state: "closed", closedAt: "2026-09-10T12:00:00Z" }, null, false)).toEqual(
      before,
    );
  });
  it("does not hide open or unknown linked work because of inactivity", () => {
    expect(decide({ pullRequests: [link("open")] })).toBeNull();
    expect(decide({ pullRequests: [{ ...link("closed"), snapshot: null }] })).toBeNull();
    expect(decide({ pullRequests: [link("merged"), link("open", 2)] })).toBeNull();
    expect(
      decide(
        { pullRequests: [link("merged"), { ...link("open", 2), source: "stack-dismissed" }] },
        null,
        null,
      ),
    ).toEqual(before);
  });
  it("protects archived, deleted, active, delegated and background work", () => {
    for (const overrides of [
      { archivedAt: before },
      { deletedAt: before },
      { settledOverride: "active" as const },
      { workInboxRole: "main" as const },
      { activeRunId: RunId.make("run") },
      { status: "queued" as const },
      { backgroundProcessCount: 1 },
      { activeAgentCount: 1 },
    ])
      expect(decide(overrides)).toBeNull();
  });
  it("distinguishes blocking requests from asynchronous questions", () => {
    const request = {
      id: RuntimeRequestId.make("question"),
      kind: "user_input" as const,
      createdAt: before,
    };
    expect(decide({ pendingRuntimeRequest: request })).toBeNull();
    expect(decide({ pendingRuntimeRequest: { ...request, responseMode: "callback" } })).toBeNull();
    expect(decide({ pendingRuntimeRequest: { ...request, responseMode: "message" } })).toEqual(
      before,
    );
  });
  it("bounds queued-message protection and accepts failed starts", () => {
    expect(isAutoSettlementCandidate(thread({ latestUserMessageAt: now }), now)).toBe(false);
    expect(
      isAutoSettlementCandidate(thread({ latestUserMessageAt: now, status: "failed" }), now),
    ).toBe(true);
    expect(
      isAutoSettlementCandidate(thread({ latestUserMessageAt: date("2026-09-11T11:57:00Z") }), now),
    ).toBe(true);
  });
  it("respects snooze unless a run completes or fails after it", () => {
    const snooze = {
      snoozedUntil: date("2026-09-12T12:00:00Z"),
      snoozedAt: date("2026-09-10T12:00:00Z"),
    };
    expect(decide(snooze)).toBeNull();
    expect(isAutoSettlementCandidate(thread({ ...snooze, latestRunCompletedAt: now }), now)).toBe(
      true,
    );
  });
});
