import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { decodeGitHubPullRequestJson } from "./gitHubPullRequests.ts";
import { decodeGitLabMergeRequestJson } from "./gitLabMergeRequests.ts";
import { decodeAzureDevOpsPullRequestJson } from "./azureDevOpsPullRequests.ts";
import { normalizeBitbucketPullRequestRecord } from "./bitbucketPullRequests.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const mergedAt = "2026-09-10T12:00:00Z";
const closedAt = "2026-09-09T12:00:00Z";

it("preserves GitHub draft and lifecycle dates independently of last activity", () => {
  expect(
    decodeGitHubPullRequestJson(
      encode({
        number: 1,
        title: "Draft",
        url: "https://github.com/org/repo/pull/1",
        baseRefName: "main",
        headRefName: "feature",
        state: "OPEN",
        isDraft: true,
        mergedAt,
        closedAt,
        updatedAt: "2026-09-11T12:00:00Z",
      }),
    ),
  ).toMatchObject({
    _tag: "Success",
    success: { isDraft: true, state: "merged", mergedAt, closedAt },
  });
});

it("accepts both GitLab draft spellings and retains terminal timestamps", () => {
  for (const draft of [{ draft: true }, { work_in_progress: true }]) {
    expect(
      decodeGitLabMergeRequestJson(
        encode({
          iid: 1,
          title: "Draft",
          web_url: "https://gitlab.com/org/repo/-/merge_requests/1",
          source_branch: "feature",
          target_branch: "main",
          state: "merged",
          ...draft,
          merged_at: mergedAt,
          closed_at: closedAt,
        }),
      ),
    ).toMatchObject({
      _tag: "Success",
      success: { isDraft: true, state: "merged", mergedAt, closedAt },
    });
  }
});

it("assigns Azure's terminal date to the actual completion state", () => {
  for (const [status, state] of [
    ["completed", "merged"],
    ["abandoned", "closed"],
  ] as const) {
    const terminal = "2026-09-10T12:00:00.000Z";
    expect(
      decodeAzureDevOpsPullRequestJson(
        encode({
          pullRequestId: 1,
          title: "Change",
          sourceRefName: "refs/heads/feature",
          targetRefName: "refs/heads/main",
          status,
          isDraft: true,
          closedDate: terminal,
          url: "https://dev.azure.com/org/project/_git/repo/pullrequest/1",
        }),
      ),
    ).toMatchObject({
      _tag: "Success",
      success: {
        state,
        isDraft: true,
        mergedAt: state === "merged" ? terminal : null,
        closedAt: state === "closed" ? terminal : null,
      },
    });
  }
});

it("retains Bitbucket draft state without inventing unavailable terminal dates", () => {
  const normalized = normalizeBitbucketPullRequestRecord({
    id: 1,
    title: "Draft",
    state: "OPEN",
    draft: true,
    links: { html: { href: "https://bitbucket.org/org/repo/pull-requests/1" } },
    source: { branch: { name: "feature" } },
    destination: { branch: { name: "main" } },
  });
  expect(normalized).toMatchObject({ isDraft: true, state: "open" });
  expect(normalized).not.toHaveProperty("mergedAt");
});
