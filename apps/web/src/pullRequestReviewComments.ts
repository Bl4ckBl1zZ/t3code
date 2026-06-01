import type { EnvironmentId, ReviewPullRequestComment, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const PULL_REQUEST_COMMENT_SEEN_STORAGE_KEY = "t3code:pull-request-comment-seen:v1";

export const PullRequestCommentSeenStateSchema = Schema.Record(
  Schema.String,
  Schema.Array(Schema.String),
);
export type PullRequestCommentSeenState = typeof PullRequestCommentSeenStateSchema.Type;

export function pullRequestCommentSeenScopeKey(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly repository: string;
  readonly pullRequestNumber: number;
}): string {
  return [
    input.environmentId,
    input.threadId,
    input.repository.toLowerCase(),
    String(input.pullRequestNumber),
  ].join(":");
}

function escapeReviewCommentAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

function reviewCommentRangeLabel(comment: ReviewPullRequestComment): string {
  if (comment.startLine !== null && comment.line !== null && comment.startLine !== comment.line) {
    return `lines ${comment.startLine}-${comment.line}`;
  }
  if (comment.line !== null) {
    return `line ${comment.line}`;
  }
  return "line";
}

function reviewCommentLine(comment: ReviewPullRequestComment): number {
  return comment.line ?? comment.startLine ?? 0;
}

function reviewCommentStartLine(comment: ReviewPullRequestComment): number {
  return comment.startLine ?? comment.line ?? 0;
}

function commentAuthor(comment: ReviewPullRequestComment): string {
  return comment.authorLogin ? `@${comment.authorLogin}` : "Unknown author";
}

export function buildPullRequestCommentPromptBlock(comment: ReviewPullRequestComment): string {
  const header = [
    `PR comment from ${commentAuthor(comment)}`,
    comment.url ? `URL: ${comment.url}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const body = [header, comment.body.trim()].filter(Boolean).join("\n\n");

  if (comment.kind !== "inline" || !comment.filePath) {
    return body;
  }

  const diff = comment.diffHunk?.trim();
  return [
    `<review_comment sectionId="${escapeReviewCommentAttribute(comment.id)}" sectionTitle="${escapeReviewCommentAttribute(
      `PR comment from ${commentAuthor(comment)}`,
    )}" filePath="${escapeReviewCommentAttribute(comment.filePath)}" startIndex="${reviewCommentStartLine(
      comment,
    )}" endIndex="${reviewCommentLine(comment)}" rangeLabel="${escapeReviewCommentAttribute(
      reviewCommentRangeLabel(comment),
    )}">`,
    body,
    diff ? ["```diff", diff, "```"].join("\n") : "",
    "</review_comment>",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildPullRequestCommentsPrompt(
  comments: ReadonlyArray<ReviewPullRequestComment>,
): string {
  return comments.map(buildPullRequestCommentPromptBlock).join("\n\n");
}

export function appendPullRequestCommentsPrompt(input: {
  readonly currentPrompt: string;
  readonly comments: ReadonlyArray<ReviewPullRequestComment>;
}): string {
  const addition = buildPullRequestCommentsPrompt(input.comments);
  if (addition.trim().length === 0) {
    return input.currentPrompt;
  }
  const current = input.currentPrompt.trimEnd();
  return current.length > 0 ? `${current}\n\n${addition}` : addition;
}
