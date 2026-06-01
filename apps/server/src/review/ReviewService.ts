import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";

import {
  SourceControlProviderError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewPullRequestComment,
  type ReviewPullRequestCommentsError,
  type ReviewPullRequestCommentsInput,
  type ReviewPullRequestCommentsResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export interface ReviewServiceShape {
  readonly getDiffPreview: (
    input: ReviewDiffPreviewInput,
  ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
  readonly listPullRequestComments: (
    input: ReviewPullRequestCommentsInput,
  ) => Effect.Effect<ReviewPullRequestCommentsResult, ReviewPullRequestCommentsError>;
}

export class ReviewService extends Context.Service<ReviewService, ReviewServiceShape>()(
  "t3/review/ReviewService",
) {}

const RawGitHubUser = Schema.NullOr(
  Schema.Struct({
    login: Schema.String,
  }),
);

const RawGitHubConversationComment = Schema.Struct({
  id: Schema.Number,
  node_id: Schema.optional(Schema.String),
  body: Schema.NullOr(Schema.String),
  user: RawGitHubUser,
  html_url: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
});
type RawGitHubConversationComment = typeof RawGitHubConversationComment.Type;

const RawGitHubInlineComment = Schema.Struct({
  id: Schema.Number,
  node_id: Schema.optional(Schema.String),
  body: Schema.NullOr(Schema.String),
  user: RawGitHubUser,
  html_url: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  path: Schema.NullOr(Schema.String),
  diff_hunk: Schema.NullOr(Schema.String),
  start_line: Schema.NullOr(Schema.Number),
  original_start_line: Schema.NullOr(Schema.Number),
  line: Schema.NullOr(Schema.Number),
  original_line: Schema.NullOr(Schema.Number),
});
type RawGitHubInlineComment = typeof RawGitHubInlineComment.Type;

const RawGitHubConversationCommentPages = Schema.Array(Schema.Array(RawGitHubConversationComment));
const RawGitHubInlineCommentPages = Schema.Array(Schema.Array(RawGitHubInlineComment));
const decodeRawGitHubConversationCommentPages = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubConversationCommentPages),
);
const decodeRawGitHubInlineCommentPages = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubInlineCommentPages),
);

const decodeGitHubConversationCommentPages = (raw: string) =>
  decodeRawGitHubConversationCommentPages(raw).pipe(
    Effect.mapError((error) =>
      githubProviderError("listPullRequestComments.conversation.decode", error),
    ),
  );

const decodeGitHubInlineCommentPages = (raw: string) =>
  decodeRawGitHubInlineCommentPages(raw).pipe(
    Effect.mapError((error) => githubProviderError("listPullRequestComments.inline.decode", error)),
  );

function githubProviderError(operation: string, cause: unknown): SourceControlProviderError {
  const detail =
    cause instanceof Error && cause.message.trim().length > 0 ? cause.message : String(cause);
  return new SourceControlProviderError({
    provider: "github",
    operation,
    detail,
    cause,
  });
}

function positiveLine(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.trunc(value));
}

function commentId(
  kind: "conversation" | "inline",
  raw: { id: number; node_id?: string | undefined },
) {
  return raw.node_id && raw.node_id.trim().length > 0 ? raw.node_id : `${kind}:${raw.id}`;
}

function toConversationPullRequestComment(
  raw: RawGitHubConversationComment,
): ReviewPullRequestComment {
  return {
    id: commentId("conversation", raw),
    kind: "conversation",
    body: raw.body ?? "",
    authorLogin: raw.user?.login ?? null,
    url: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    filePath: null,
    startLine: null,
    line: null,
    diffHunk: null,
  };
}

function toInlinePullRequestComment(raw: RawGitHubInlineComment): ReviewPullRequestComment {
  const line = positiveLine(raw.line ?? raw.original_line);
  const startLine = positiveLine(raw.start_line ?? raw.original_start_line) ?? line;
  return {
    id: commentId("inline", raw),
    kind: "inline",
    body: raw.body ?? "",
    authorLogin: raw.user?.login ?? null,
    url: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    filePath: raw.path?.trim() || null,
    startLine,
    line,
    diffHunk: raw.diff_hunk,
  };
}

function fetchGithubApiPages<T>(input: {
  readonly github: GitHubCli.GitHubCliShape;
  readonly cwd: string;
  readonly endpoint: string;
  readonly decode: (raw: string) => Effect.Effect<T, SourceControlProviderError>;
  readonly operation: string;
}): Effect.Effect<T, SourceControlProviderError> {
  return input.github
    .execute({
      cwd: input.cwd,
      args: ["api", input.endpoint, "--paginate", "--slurp"],
      timeoutMs: 30_000,
    })
    .pipe(
      Effect.mapError((error) => githubProviderError(input.operation, error)),
      Effect.map((result) => result.stdout.trim()),
      Effect.flatMap((raw) => input.decode(raw.length > 0 ? raw : "[]")),
    );
}

export const make = Effect.fn("makeReviewService")(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const github = yield* GitHubCli.GitHubCli;
  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const canonicalizePath = (value: string) =>
    fileSystem
      .realPath(path.resolve(value))
      .pipe(Effect.catch(() => Effect.succeed(path.resolve(value))));

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    cwd: string,
  ) {
    const [candidate, workspaceRoot, worktreesRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
      canonicalizePath(config.worktreesDir),
    ]);

    if (isWithinRoot(candidate, workspaceRoot) || isWithinRoot(candidate, worktreesRoot)) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation: "ReviewService.getDiffPreview",
      cwd,
      detail: "Review diff preview cwd must stay within the configured workspace root.",
    });
  });

  const assertGithubRepository = Effect.fn("ReviewService.assertGithubRepository")(function* (
    input: ReviewPullRequestCommentsInput,
  ) {
    const handle = yield* sourceControlProviders.resolveHandle({ cwd: input.cwd });
    const context = handle.context;
    if (handle.provider.kind !== "github" || !context) {
      return yield* new SourceControlProviderError({
        provider: handle.provider.kind,
        operation: "listPullRequestComments",
        detail: "Pull request comments are currently available for GitHub repositories only.",
      });
    }

    const repository = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(context.remoteUrl);
    if (!repository) {
      return yield* new SourceControlProviderError({
        provider: "github",
        operation: "listPullRequestComments",
        detail: "Could not determine the GitHub repository from the configured remote.",
      });
    }
    return repository;
  });

  const getDiffPreview: ReviewServiceShape["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd(input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    const getDriverDiffPreview = handle.driver.getDiffPreview;
    if (!getDriverDiffPreview) {
      if (handle.kind === "git") {
        return yield* git.getReviewDiffPreview(input);
      }
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffPreview",
        kind: handle.kind,
        detail: `The ${handle.kind} VCS driver does not support review diff previews.`,
      });
    }

    return yield* getDriverDiffPreview(input);
  });

  const listPullRequestComments: ReviewServiceShape["listPullRequestComments"] = Effect.fn(
    "ReviewService.listPullRequestComments",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd(input.cwd);
    const repository = yield* assertGithubRepository(input);

    const [inlinePages, conversationPages] = yield* Effect.all(
      [
        fetchGithubApiPages({
          github,
          cwd: input.cwd,
          endpoint: `repos/${repository}/pulls/${input.pullRequestNumber}/comments?per_page=100`,
          decode: decodeGitHubInlineCommentPages,
          operation: "listPullRequestComments.inline",
        }),
        fetchGithubApiPages({
          github,
          cwd: input.cwd,
          endpoint: `repos/${repository}/issues/${input.pullRequestNumber}/comments?per_page=100`,
          decode: decodeGitHubConversationCommentPages,
          operation: "listPullRequestComments.conversation",
        }),
      ],
      { concurrency: "unbounded" },
    );

    const comments = [
      ...inlinePages.flat().map(toInlinePullRequestComment),
      ...conversationPages.flat().map(toConversationPullRequestComment),
    ].toSorted((left, right) => {
      const createdOrder = left.createdAt.localeCompare(right.createdAt);
      return createdOrder !== 0 ? createdOrder : left.id.localeCompare(right.id);
    });

    return {
      cwd: input.cwd,
      repository,
      pullRequestNumber: input.pullRequestNumber,
      comments,
    };
  });

  return ReviewService.of({
    getDiffPreview,
    listPullRequestComments,
  });
});

export const layer = Layer.effect(ReviewService, make());
