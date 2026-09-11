import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PullRequestState } from "./pullRequest.ts";
import { ThreadPullRequestLinkSource } from "./threadPullRequestLinks.ts";

export class McpPullRequestCapabilityUnavailableError extends Schema.TaggedErrorClass<McpPullRequestCapabilityUnavailableError>()(
  "McpPullRequestCapabilityUnavailableError",
  {},
) {
  override get message(): string {
    return "MCP credential does not grant the pull-requests capability.";
  }
}

/**
 * Either the pull request's URL or its repository and number. Both forms
 * resolve to the same host-level identity, so the agent can pass whichever
 * the host CLI handed back.
 */
export const PullRequestTargetInput = Schema.Struct({
  url: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "The pull request's web URL, for example https://github.com/owner/repo/pull/123. Preferred when you have it; host, repository and number are read from it.",
    }),
  ),
  repository: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Repository path below the host, for example owner/repo. Required with number when url is omitted.",
    }),
  ),
  number: Schema.optional(
    PositiveInt.annotate({
      description: "Pull request number. Required with repository when url is omitted.",
    }),
  ),
  host: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Host the repository lives on, for example github.com. Defaults to the host of this thread's project.",
    }),
  ),
});
export type PullRequestTargetInput = typeof PullRequestTargetInput.Type;

export class PullRequestUrlInvalidError extends Schema.TaggedErrorClass<PullRequestUrlInvalidError>()(
  "PullRequestUrlInvalidError",
  {},
) {
  override get message(): string {
    return "This is not a recognised pull request URL. Pass repository and number instead.";
  }
}

export class PullRequestTargetIncompleteError extends Schema.TaggedErrorClass<PullRequestTargetIncompleteError>()(
  "PullRequestTargetIncompleteError",
  {},
) {
  override get message(): string {
    return "Pass either url, or both repository and number.";
  }
}

export class PullRequestHostRequiredError extends Schema.TaggedErrorClass<PullRequestHostRequiredError>()(
  "PullRequestHostRequiredError",
  {},
) {
  override get message(): string {
    return "This thread's project has no recognised remote. Pass host or url.";
  }
}

export class PullRequestThreadNotFoundError extends Schema.TaggedErrorClass<PullRequestThreadNotFoundError>()(
  "PullRequestThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class PullRequestLinkFailedError extends Schema.TaggedErrorClass<PullRequestLinkFailedError>()(
  "PullRequestLinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not link the pull request.";
  }
}

export class PullRequestUnlinkFailedError extends Schema.TaggedErrorClass<PullRequestUnlinkFailedError>()(
  "PullRequestUnlinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not unlink the pull request.";
  }
}

export class PullRequestListFailedError extends Schema.TaggedErrorClass<PullRequestListFailedError>()(
  "PullRequestListFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not list the pull request.";
  }
}

export const PullRequestToolError = Schema.Union([
  McpPullRequestCapabilityUnavailableError,
  PullRequestUrlInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestHostRequiredError,
  PullRequestThreadNotFoundError,
  PullRequestLinkFailedError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
]);
export type PullRequestToolError = typeof PullRequestToolError.Type;

const PullRequestIdentity = {
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  url: Schema.String,
};

export const LinkPullRequestResult = Schema.Struct({
  ...PullRequestIdentity,
  alreadyLinked: Schema.Boolean.annotate({
    description: "True when the pull request was linked to this thread before the call.",
  }),
});
export type LinkPullRequestResult = typeof LinkPullRequestResult.Type;

export const UnlinkPullRequestResult = Schema.Struct({
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  wasLinked: Schema.Boolean.annotate({
    description: "False when the pull request was not linked to this thread to begin with.",
  }),
});
export type UnlinkPullRequestResult = typeof UnlinkPullRequestResult.Type;

export const ThreadPullRequestEntry = Schema.Struct({
  ...PullRequestIdentity,
  source: ThreadPullRequestLinkSource,
  state: Schema.NullOr(PullRequestState),
  title: Schema.NullOr(Schema.String),
  headBranch: Schema.NullOr(Schema.String),
  baseBranch: Schema.NullOr(Schema.String),
  isDraft: Schema.NullOr(Schema.Boolean),
  stack: Schema.NullOr(
    Schema.Struct({
      kind: Schema.Literals(["native", "derived"]),
      /** 1-based, bottom of the stack first. */
      position: Schema.Int,
      size: Schema.Int,
    }),
  ),
});
export type ThreadPullRequestEntry = typeof ThreadPullRequestEntry.Type;

export const ListThreadPullRequestsResult = Schema.Struct({
  pullRequests: Schema.Array(ThreadPullRequestEntry),
  chains: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["native", "derived"]),
      /** Bottom to top. */
      numbers: Schema.Array(Schema.Int),
    }),
  ),
});
export type ListThreadPullRequestsResult = typeof ListThreadPullRequestsResult.Type;
