import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { SourceControlProviderError } from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;

export const ReviewPullRequestCommentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  pullRequestNumber: PositiveInt,
});
export type ReviewPullRequestCommentsInput = typeof ReviewPullRequestCommentsInput.Type;

export const ReviewPullRequestCommentKind = Schema.Literals(["conversation", "inline"]);
export type ReviewPullRequestCommentKind = typeof ReviewPullRequestCommentKind.Type;

export const ReviewPullRequestComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewPullRequestCommentKind,
  body: Schema.String,
  authorLogin: Schema.NullOr(TrimmedNonEmptyString),
  url: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  filePath: Schema.NullOr(TrimmedNonEmptyString),
  startLine: Schema.NullOr(NonNegativeInt),
  line: Schema.NullOr(NonNegativeInt),
  diffHunk: Schema.NullOr(Schema.String),
});
export type ReviewPullRequestComment = typeof ReviewPullRequestComment.Type;

export const ReviewPullRequestCommentsResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  pullRequestNumber: PositiveInt,
  comments: Schema.Array(ReviewPullRequestComment),
});
export type ReviewPullRequestCommentsResult = typeof ReviewPullRequestCommentsResult.Type;

export const ReviewPullRequestCommentsError = Schema.Union([
  VcsError,
  GitCommandError,
  SourceControlProviderError,
]);
export type ReviewPullRequestCommentsError = typeof ReviewPullRequestCommentsError.Type;
