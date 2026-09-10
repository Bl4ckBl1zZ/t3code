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
