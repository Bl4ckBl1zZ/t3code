import type { ReviewPullRequestComment } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PullRequestUnreadCommentsSidePanel } from "./PullRequestUnreadCommentsPanel";

function buildReviewComment(
  overrides: Partial<ReviewPullRequestComment> = {},
): ReviewPullRequestComment {
  return {
    id: "comment-1",
    kind: "inline",
    body: "### Fix reconnect loop\n\nVerbose implementation detail should stay out of the panel.",
    authorLogin: "reviewer",
    url: "https://example.test/comment",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    filePath: "apps/web/src/store.ts",
    startLine: 12,
    line: 14,
    diffHunk: null,
    ...overrides,
  };
}

describe("PullRequestUnreadCommentsSidePanel", () => {
  it("shows comment titles without rendering the full comment body", () => {
    const markup = renderToStaticMarkup(
      <PullRequestUnreadCommentsSidePanel
        comments={[buildReviewComment()]}
        pullRequestNumber={42}
        pullRequestTitle="Reconnect fixes"
        workspaceRoot="/repo"
        isFetching={false}
        error={null}
        onAddAll={vi.fn()}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain("Fix reconnect loop");
    expect(markup).not.toContain("Verbose implementation detail");
  });
});
