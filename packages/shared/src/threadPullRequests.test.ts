import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  linkedPullRequestsOf,
  threadPullRequestSearchTerms,
  updateLinkedPullRequests,
} from "./threadPullRequests.ts";
const link = (number: number, host = "github.com") => ({
  projectId: ProjectId.make("p"),
  repository: "owner/repo",
  number,
  url: `https://${host}/owner/repo/pull/${number}`,
});
describe("V2 linked pull requests", () => {
  it("upgrades legacy state and composes successive additions without losing links", () => {
    const first = updateLinkedPullRequests(
      { linkedPullRequest: link(1) },
      { linkPullRequest: link(2) },
    );
    const second = updateLinkedPullRequests(first, { linkPullRequest: link(3) });
    expect(second.linkedPullRequests.map((x) => x.number)).toEqual([1, 2, 3]);
    expect(second.linkedPullRequest).toEqual(link(1));
  });
  it("deduplicates repository identity but keeps hosts distinct", () => {
    const initial = updateLinkedPullRequests({}, { linkPullRequest: link(1) });
    const duplicate = updateLinkedPullRequests(initial, {
      linkPullRequest: {
        ...link(1),
        projectId: ProjectId.make("another"),
        repository: "OWNER/REPO",
      },
    });
    expect(duplicate.linkedPullRequests).toHaveLength(1);
    expect(
      updateLinkedPullRequests(duplicate, { linkPullRequest: link(1, "github.enterprise") })
        .linkedPullRequests,
    ).toHaveLength(2);
  });
  it("legacy replacement and unlink preserve additional links", () => {
    const initial = { linkedPullRequest: link(1), linkedPullRequests: [link(1), link(2)] };
    expect(
      updateLinkedPullRequests(initial, { linkedPullRequest: link(3) }).linkedPullRequests.map(
        (x) => x.number,
      ),
    ).toEqual([3, 2]);
    expect(
      updateLinkedPullRequests(initial, { linkedPullRequest: null }).linkedPullRequest,
    ).toEqual(link(2));
    expect(
      updateLinkedPullRequests(initial, { unlinkPullRequest: link(2) }).linkedPullRequests,
    ).toEqual([link(1)]);
  });
  it("respects an empty collection and searches all links", () => {
    expect(linkedPullRequestsOf({ linkedPullRequest: link(1), linkedPullRequests: [] })).toEqual(
      [],
    );
    expect(threadPullRequestSearchTerms({ linkedPullRequests: [link(1), link(2)] })).toContain(
      "owner/repo#2",
    );
  });
});

describe("V2 pull request sync races", () => {
  const now = "2026-09-11T00:00:00.000Z";
  const later = "2026-09-11T00:01:00.000Z";
  const snapshot = {
    state: "open" as const,
    title: "A stacked change",
    headBranch: "feature/top",
    baseBranch: "feature/base",
    isDraft: true,
    updatedAt: now,
    syncedAt: now,
  };
  const stack = {
    kind: "native" as const,
    id: "stack-id",
    number: 9,
    url: "https://github.com/owner/repo/stack/9",
    base: "main",
    layers: [
      { number: 1, headBranch: "feature/base", state: "open" as const },
      { number: 2, headBranch: "feature/top", state: "open" as const },
    ],
  };
  it("keeps an explicitly removed stack member hidden during automatic rediscovery", () => {
    let state = updateLinkedPullRequests({}, { linkPullRequest: link(1) }, now);
    state = updateLinkedPullRequests(
      state,
      {
        syncPullRequest: { reference: state.pullRequests[0]!, snapshot, stack },
      },
      now,
    );
    state = updateLinkedPullRequests(
      state,
      { linkPullRequest: link(2), linkPullRequestSource: "stack" },
      now,
    );
    state = updateLinkedPullRequests(state, { unlinkPullRequest: link(2) }, later);
    expect(state.pullRequests[1]?.source).toBe("stack-dismissed");
    state = updateLinkedPullRequests(
      state,
      { linkPullRequest: link(2), linkPullRequestSource: "stack" },
      later,
    );
    expect(state.linkedPullRequests.map((item) => item.number)).toEqual([1]);
    state = updateLinkedPullRequests(
      state,
      { linkPullRequest: link(2), linkPullRequestSource: "agent" },
      later,
    );
    expect(state.linkedPullRequests.map((item) => item.number)).toEqual([1, 2]);
    expect(state.pullRequests[1]?.source).toBe("agent");
    expect(state.pullRequests[1]?.linkedAt).toBe(later);
  });
  it("tombstones a manually linked member identified by a sibling's native stack", () => {
    let state = updateLinkedPullRequests({}, { linkPullRequest: link(1) }, now);
    state = updateLinkedPullRequests(state, { linkPullRequest: link(2) }, now);
    state = updateLinkedPullRequests(
      state,
      {
        syncPullRequest: { reference: state.pullRequests[0]!, snapshot, stack },
      },
      now,
    );
    state = updateLinkedPullRequests(state, { unlinkPullRequest: link(2) }, later);
    expect(state.pullRequests[1]?.source).toBe("stack-dismissed");
  });
  it("does not recreate an unlinked request when a host read finishes", () => {
    const initial = updateLinkedPullRequests({}, { linkPullRequest: link(1) }, now);
    const removed = updateLinkedPullRequests(initial, { unlinkPullRequest: link(1) }, later);
    const synced = updateLinkedPullRequests(
      removed,
      {
        syncPullRequest: { reference: initial.pullRequests[0]!, snapshot, stack: null },
      },
      later,
    );
    expect(synced.pullRequests).toEqual([]);
    expect(synced.linkedPullRequest).toBeNull();
  });
  it("rejects an old host read after the same request is removed and explicitly relinked", () => {
    const initial = updateLinkedPullRequests({}, { linkPullRequest: link(1) }, now);
    const removed = updateLinkedPullRequests(initial, { unlinkPullRequest: link(1) }, later);
    const relinked = updateLinkedPullRequests(removed, { linkPullRequest: link(1) }, later);
    const synced = updateLinkedPullRequests(
      relinked,
      {
        syncPullRequest: { reference: initial.pullRequests[0]!, snapshot, stack: null },
      },
      later,
    );
    expect(synced.pullRequests[0]?.snapshot).toBeNull();
    expect(synced.pullRequests[0]?.linkedAt).toBe(later);
  });
  it("selects the highest open stack member for legacy clients and searches its cached title", () => {
    let state = updateLinkedPullRequests({}, { linkPullRequest: link(1) }, now);
    state = updateLinkedPullRequests(
      state,
      { linkPullRequest: link(2), linkPullRequestSource: "stack" },
      now,
    );
    state = updateLinkedPullRequests(
      state,
      {
        syncPullRequest: {
          reference: state.pullRequests[0]!,
          snapshot: { ...snapshot, headBranch: "feature/base", baseBranch: "main" },
          stack,
        },
      },
      now,
    );
    state = updateLinkedPullRequests(
      state,
      {
        syncPullRequest: { reference: state.pullRequests[1]!, snapshot, stack },
      },
      now,
    );
    expect(state.linkedPullRequest?.number).toBe(2);
    expect(threadPullRequestSearchTerms(state)).toContain("A stacked change");
    state = updateLinkedPullRequests(
      state,
      {
        syncPullRequest: {
          reference: state.pullRequests[1]!,
          snapshot: { ...snapshot, state: "merged" },
          stack,
        },
      },
      later,
    );
    expect(state.linkedPullRequest?.number).toBe(1);
  });
});

it("keeps Azure's short repository selector for legacy readers while canonicalizing link identity", () => {
  const legacy = {
    projectId: ProjectId.make("azure"),
    repository: "repo",
    number: 12,
    url: "https://dev.azure.com/org/project/_git/repo/pullrequest/12",
  };
  const state = updateLinkedPullRequests({}, { linkPullRequest: legacy });
  expect(state.pullRequests[0]?.repository).toBe("org/project/_git/repo");
  expect(state.linkedPullRequest).toEqual(legacy);
  expect(state.linkedPullRequests).toEqual([legacy]);
});
