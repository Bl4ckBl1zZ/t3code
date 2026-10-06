import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Request from "effect/Request";
import * as RequestResolver from "effect/RequestResolver";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  TrimmedNonEmptyString,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  decodeGitHubPullRequestEntries,
  decodeGitHubPullRequestJson,
  decodeGitHubPullRequestListJson,
  type NormalizedGitHubPullRequestRecord,
} from "./gitHubPullRequests.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

const gitHubCliFailureFields = {
  command: Schema.Literal("gh"),
  cwd: Schema.String,
  cause: Schema.Defect(),
} as const;

export class GitHubCliUnavailableError extends Schema.TaggedErrorClass<GitHubCliUnavailableError>()(
  "GitHubCliUnavailableError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI (`gh`) is required but not available on PATH.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliAuthenticationError extends Schema.TaggedErrorClass<GitHubCliAuthenticationError>()(
  "GitHubCliAuthenticationError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI is not authenticated. Run `gh auth login` and retry.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliRateLimitError extends Schema.TaggedErrorClass<GitHubCliRateLimitError>()(
  "GitHubCliRateLimitError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub API rate limit exceeded. For the GraphQL quota and reset time, run `gh api graphql -f query='{rateLimit{remaining resetAt}}'`; `gh api rate_limit` reports REST.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubPullRequestNotFoundError extends Schema.TaggedErrorClass<GitHubPullRequestNotFoundError>()(
  "GitHubPullRequestNotFoundError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "Pull request not found. Check the PR number or URL and try again.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliCommandError extends Schema.TaggedErrorClass<GitHubCliCommandError>()(
  "GitHubCliCommandError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI command failed.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

const gitHubCliDecodeFields = {
  command: Schema.Literal("gh"),
  cwd: Schema.String,
  cause: Schema.Defect(),
} as const;

export class GitHubPullRequestListDecodeError extends Schema.TaggedErrorClass<GitHubPullRequestListDecodeError>()(
  "GitHubPullRequestListDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid PR list JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listOpenPullRequests: ${this.detail}`;
  }
}

export class GitHubChangeRequestListDecodeError extends Schema.TaggedErrorClass<GitHubChangeRequestListDecodeError>()(
  "GitHubChangeRequestListDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid change request JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listChangeRequests: ${this.detail}`;
  }
}

export class GitHubPullRequestDecodeError extends Schema.TaggedErrorClass<GitHubPullRequestDecodeError>()(
  "GitHubPullRequestDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in getPullRequest: ${this.detail}`;
  }
}

export class GitHubRepositoryDecodeError extends Schema.TaggedErrorClass<GitHubRepositoryDecodeError>()(
  "GitHubRepositoryDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid repository JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in getRepositoryCloneUrls: ${this.detail}`;
  }
}

export const GitHubCliError = Schema.Union([
  GitHubCliUnavailableError,
  GitHubCliAuthenticationError,
  GitHubCliRateLimitError,
  GitHubPullRequestNotFoundError,
  GitHubCliCommandError,
  GitHubPullRequestListDecodeError,
  GitHubChangeRequestListDecodeError,
  GitHubPullRequestDecodeError,
  GitHubRepositoryDecodeError,
]);
export type GitHubCliError = typeof GitHubCliError.Type;

export const isGitHubCliError = Schema.is(GitHubCliError);

export function fromVcsError(
  context: {
    readonly command: "gh";
    readonly cwd: string;
  },
  error: VcsError,
): GitHubCliError {
  if (
    error._tag === "VcsProcessSpawnError" &&
    error.cause instanceof PlatformError.PlatformError &&
    error.cause.reason._tag === "NotFound" &&
    error.cause.reason.module === "ChildProcess" &&
    error.cause.reason.method === "spawn"
  ) {
    return new GitHubCliUnavailableError({ ...context, cause: error });
  }

  if (error._tag === "VcsProcessExitError") {
    if (error.failureKind === "authentication") {
      return new GitHubCliAuthenticationError({ ...context, cause: error });
    }
    if (error.failureKind === "rate-limited") {
      return new GitHubCliRateLimitError({ ...context, cause: error });
    }
    if (error.failureKind === "not-found") {
      return new GitHubPullRequestNotFoundError({ ...context, cause: error });
    }
  }

  return new GitHubCliCommandError({ ...context, cause: error });
}

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly isDraft?: boolean;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt?: string;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

function pullRequestSummary(input: NormalizedGitHubPullRequestRecord): GitHubPullRequestSummary {
  const { updatedAt, ...summary } = input;
  return {
    ...summary,
    ...(Option.isSome(updatedAt) ? { updatedAt: DateTime.formatIso(updatedAt.value) } : {}),
  };
}

export interface GitHubRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export class GitHubCli extends Context.Service<
  GitHubCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
      /** Piped to the child's stdin, for payloads that must never appear in argv. */
      readonly stdin?: string;
      readonly maxOutputBytes?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCliError>;

    readonly listOpenPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

    /**
     * Pull requests whose head is `headSelector`, in the repository `gh pr list` would read in
     * `cwd`. Lookups on one repository that arrive together share one GraphQL document; a
     * checkout whose repository gh could pick another way is asked through `gh pr list`.
     */
    readonly listPullRequestsByHead: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit: number;
      /** The checkout's GitHub host. Without it the lookup is not batched. */
      readonly host?: string;
    }) => Effect.Effect<ReadonlyArray<NormalizedGitHubPullRequestRecord>, GitHubCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<GitHubPullRequestSummary, GitHubCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
    }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, GitHubCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string | null, GitHubCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, GitHubCliError>;
  }
>()("t3/sourceControl/GitHubCli") {}

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
const decodeRawGitHubRepositoryCloneUrls = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubRepositoryCloneUrlsSchema),
);

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

/**
 * `gh repo create` prints the canonical URL of the new repository on stdout
 * (e.g. `https://github.com/owner/repo`). Reading it back here avoids a
 * follow-up `gh repo view`, which can race GitHub's GraphQL eventual
 * consistency window and falsely report the just-created repo as missing.
 */
function deriveRepositoryCloneUrlsFromCreateOutput(
  stdout: string,
  repository: string,
): GitHubRepositoryCloneUrls {
  const fallbackHost = "github.com";
  const match = stdout.match(/https?:\/\/[^\s]+/);
  if (match) {
    const cleaned = match[0].replace(/\.git$/, "");
    try {
      const parsed = new URL(cleaned);
      const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
      const segments = pathname.split("/").filter(Boolean);
      if (segments.length === 2) {
        const nameWithOwner = `${segments[0]}/${segments[1]}`;
        return {
          nameWithOwner,
          url: `${parsed.origin}/${nameWithOwner}`,
          sshUrl: `git@${parsed.host}:${nameWithOwner}.git`,
        };
      }
    } catch {
      // Fall through to the input-derived defaults below.
    }
  }
  return {
    nameWithOwner: repository,
    url: `https://${fallbackHost}/${repository}`,
    sshUrl: `git@${fallbackHost}:${repository}.git`,
  };
}

type PullRequestListState = "open" | "closed" | "merged" | "all";

const PULL_REQUEST_LIST_JSON_FIELDS =
  "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner";
/** The `gh pr list --json` fields above, as GraphQL selects them. */
const PULL_REQUEST_NODE_SELECTION =
  "number title url baseRefName headRefName state isDraft mergedAt closedAt updatedAt isCrossRepository headRepository { name nameWithOwner } headRepositoryOwner { login }";
const GRAPHQL_STATES: Record<PullRequestListState, ReadonlyArray<string>> = {
  open: ["OPEN"],
  closed: ["CLOSED"],
  merged: ["MERGED"],
  all: ["OPEN", "CLOSED", "MERGED"],
};
/**
 * Head lookups per GraphQL document. A document of a hundred costs one point, the same as one
 * `gh pr list`, but half that keeps each answer near half a second.
 */
const HEAD_LOOKUPS_PER_DOCUMENT = 50;
/**
 * How long a head lookup waits for company. Branch discovery reaches GitHub only after each
 * branch's own git reads, so lookups started together arrive tens of milliseconds apart.
 */
const HEAD_LOOKUP_BATCH_WINDOW = "50 millis";
/** A full document is 5,000 rows of well under 2 KB each. */
const HEAD_LOOKUP_MAX_OUTPUT_BYTES = 16_000_000;

class PullRequestsByHeadRead extends Request.Class<
  {
    readonly cwd: string;
    readonly host: string;
    readonly owner: string;
    readonly name: string;
    readonly headRefName: string;
    readonly state: PullRequestListState;
    readonly limit: number;
  },
  ReadonlyArray<NormalizedGitHubPullRequestRecord>,
  GitHubCliError
> {}

const GraphQlVariables = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);
/** A GraphQL request body for `gh api graphql --input -`. */
const encodeGraphQlRequest = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ query: Schema.String, variables: GraphQlVariables })),
);

/** One aliased `pullRequests` connection per lookup, each head and state passed as a variable. */
function buildPullRequestsByHeadQuery(
  lookups: ReadonlyArray<Pick<PullRequestsByHeadRead, "headRefName" | "state" | "limit">>,
): { readonly document: string; readonly variables: typeof GraphQlVariables.Type } {
  const variables: Record<string, string | ReadonlyArray<string>> = {};
  const declarations: string[] = ["$owner: String!", "$name: String!"];
  const selections: string[] = [];
  for (const [index, lookup] of lookups.entries()) {
    variables[`h${index}`] = lookup.headRefName;
    variables[`s${index}`] = GRAPHQL_STATES[lookup.state];
    declarations.push(`$h${index}: String!`, `$s${index}: [PullRequestState!]`);
    // `gh pr list` orders the same way, so a head with more matches than the limit keeps the
    // same rows.
    selections.push(
      `    h${index}: pullRequests(headRefName: $h${index}, states: $s${index}, first: ${lookup.limit}, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${PULL_REQUEST_NODE_SELECTION} } }`,
    );
  }
  return {
    document: `query PullRequestsByHead(${declarations.join(", ")}) {\n  repository(owner: $owner, name: $name) {\n${selections.join("\n")}\n  }\n}`,
    variables,
  };
}

const decodePullRequestsByHead = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.Record(
        Schema.String,
        Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Schema.Unknown) })),
      ),
    }),
  }),
);

/**
 * The repository `gh pr list` reads in a checkout, picked the way gh picks one without a
 * prompt: the remote `gh repo set-default` marked, else the first of upstream, github, origin
 * (in any case), else the only remote. `remotes` is `git remote -v` output and `resolved` is the
 * output of `git config --get-regexp '^remote\..*\.gh-resolved$'`.
 *
 * Null whenever gh might weigh the remotes differently: a remote on another host or under an
 * SSH alias, more than one mark, or several remotes with none of those names. Callers then
 * ask gh itself.
 */
export function selectGitHubBaseRepository(input: {
  readonly remotes: string;
  readonly resolved: string;
  readonly host: string;
}): { readonly owner: string; readonly name: string } | null {
  const host = input.host.toLowerCase();
  const repositories = new Map<string, { readonly owner: string; readonly name: string }>();
  for (const line of input.remotes.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/u.exec(line.trim());
    if (!match) continue;
    const [remoteHost, owner, name, ...rest] = normalizeGitRemoteUrl(match[2]!).split("/");
    if (remoteHost !== host || !owner || !name || rest.length > 0) return null;
    repositories.set(match[1]!, { owner, name });
  }
  const marks = input.resolved
    .split("\n")
    .map((line) => /^remote\.(.+)\.gh-resolved\s+(\S+)$/u.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null && repositories.has(match[1]!));
  if (marks.length > 1) return null;
  const [mark] = marks;
  if (mark) {
    if (mark[2] === "base") return repositories.get(mark[1]!) ?? null;
    const [owner, name, ...rest] = mark[2]!.toLowerCase().split("/");
    return owner && name && rest.length === 0 ? { owner, name } : null;
  }
  // gh sorts remotes by these names, case-insensitively, and takes the first. A tie for the
  // top place has no defined winner.
  const score = (remoteName: string) =>
    ["origin", "github", "upstream"].indexOf(remoteName.toLowerCase()) + 1;
  const ranked = [...repositories.entries()].toSorted(
    ([left], [right]) => score(right) - score(left),
  );
  const [top, next] = ranked;
  return top !== undefined && (next === undefined || score(top[0]) > score(next[0]))
    ? top[1]
    : null;
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const execute: GitHubCli["Service"]["execute"] = (input) =>
    process
      .run({
        operation: "GitHubCli.execute",
        command: "gh",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      })
      .pipe(Effect.mapError((error) => fromVcsError({ command: "gh", cwd: input.cwd }, error)));

  const listPullRequestsWithCli = (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly state: PullRequestListState;
    readonly limit: number;
  }) =>
    execute({
      cwd: input.cwd,
      args: [
        "pr",
        "list",
        "--head",
        input.headSelector,
        "--state",
        input.state,
        "--limit",
        String(input.limit),
        "--json",
        PULL_REQUEST_LIST_JSON_FIELDS,
      ],
    }).pipe(
      Effect.flatMap((result) => {
        const raw = result.stdout.trim();
        if (raw.length === 0) return Effect.succeed([]);
        const decoded = decodeGitHubPullRequestListJson(raw);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new GitHubChangeRequestListDecodeError({
                command: "gh",
                cwd: input.cwd,
                cause: decoded.failure,
              }),
            );
      }),
    );

  const git = (cwd: string, args: ReadonlyArray<string>) =>
    process.run({
      operation: "GitHubCli.baseRepository",
      command: "git",
      args,
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 5_000,
    });

  /** The repository gh reads in `cwd`, or null when gh could pick it another way. */
  const resolveBaseRepository = (cwd: string, host: string) =>
    globalThis.process.env.GH_REPO
      ? Effect.succeed(null)
      : Effect.all([
          git(cwd, ["remote", "-v"]),
          git(cwd, ["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"]),
        ]).pipe(
          Effect.map(([remotes, resolved]) =>
            remotes.exitCode === 0
              ? selectGitHubBaseRepository({
                  remotes: remotes.stdout,
                  resolved: resolved.exitCode === 0 ? resolved.stdout : "",
                  host,
                })
              : null,
          ),
          Effect.orElseSucceed(() => null),
        );

  const headResolver = RequestResolver.makeGrouped<PullRequestsByHeadRead, string>({
    key: ({ request }) => JSON.stringify([request.host, request.owner, request.name]),
    resolver: (entries) => {
      const [first] = entries;
      const { cwd, host, owner, name } = first.request;
      const query = buildPullRequestsByHeadQuery(entries.map((entry) => entry.request));
      const readCli = (entry: (typeof entries)[number]) =>
        listPullRequestsWithCli({
          cwd: entry.request.cwd,
          headSelector: entry.request.headRefName,
          state: entry.request.state,
          limit: entry.request.limit,
        }).pipe(
          Effect.exit,
          Effect.map((exit) => entry.completeUnsafe(exit)),
        );
      return execute({
        cwd,
        args: ["api", "graphql", "--hostname", host, "--input", "-"],
        // Up to 50 heads of 100 rows each. A default branch such as `main` can match a
        // hundred fork pull requests, so the 1 MB default would cut the answer short.
        maxOutputBytes: HEAD_LOOKUP_MAX_OUTPUT_BYTES,
        stdin: encodeGraphQlRequest({
          query: query.document,
          variables: { owner, name, ...query.variables },
        }),
      }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodePullRequestsByHead(result.stdout);
          if (!Result.isSuccess(decoded)) {
            return Effect.forEach(entries, readCli, { discard: true });
          }
          const aliases = decoded.success.data.repository;
          return Effect.forEach(
            entries,
            (entry, index) => {
              const alias = aliases[`h${index}`];
              if (alias == null) return readCli(entry);
              entry.completeUnsafe(Exit.succeed(decodeGitHubPullRequestEntries(alias.nodes)));
              return Effect.void;
            },
            { discard: true },
          );
        }),
        // A document GitHub refused as a whole (a renamed repository, a field an older
        // Enterprise host lacks) leaves each lookup to gh. A rate limit fails them all:
        // asking one at a time would only spend more of an exhausted quota.
        Effect.catchIf(
          (error) => error._tag !== "GitHubCliRateLimitError",
          () => Effect.forEach(entries, readCli, { discard: true }),
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            for (const entry of entries) entry.completeUnsafe(Exit.failCause(cause));
          }),
        ),
      );
    },
  }).pipe(
    RequestResolver.setDelay(HEAD_LOOKUP_BATCH_WINDOW),
    RequestResolver.batchN(HEAD_LOOKUPS_PER_DOCUMENT),
  );

  const listPullRequestsByHead: GitHubCli["Service"]["listPullRequestsByHead"] = Effect.fn(
    "GitHubCli.listPullRequestsByHead",
  )(function* (input) {
    const host = input.host?.toLowerCase();
    // `owner:branch` selectors keep gh's own handling.
    const repository =
      host === undefined || input.headSelector.includes(":")
        ? null
        : yield* resolveBaseRepository(input.cwd, host);
    if (host === undefined || repository === null) {
      return yield* listPullRequestsWithCli(input);
    }
    return yield* Effect.request(
      new PullRequestsByHeadRead({
        cwd: input.cwd,
        host,
        owner: repository.owner,
        name: repository.name,
        headRefName: input.headSelector,
        state: input.state,
        limit: Math.min(Math.max(Math.trunc(input.limit), 1), 100),
      }),
      headResolver,
    );
  });

  return GitHubCli.of({
    execute,
    listPullRequestsByHead,
    listOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--head",
          input.headSelector,
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 1),
          "--json",
          "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeGitHubPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new GitHubPullRequestListDecodeError({
                        command: "gh",
                        cwd: input.cwd,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  return Effect.succeed(decoded.success.map(pullRequestSummary));
                }),
              ),
        ),
      ),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => decodeGitHubPullRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new GitHubPullRequestDecodeError({
                    command: "gh",
                    cwd: input.cwd,
                    cause: decoded.failure,
                  }),
                );
              }

              return Effect.succeed(pullRequestSummary(decoded.success));
            }),
          ),
        ),
      ),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeRawGitHubRepositoryCloneUrls(raw).pipe(
            Effect.mapError(
              (cause) =>
                new GitHubRepositoryDecodeError({
                  command: "gh",
                  cwd: input.cwd,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createRepository: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "create", input.repository, `--${input.visibility}`],
      }).pipe(
        Effect.map((result) =>
          deriveRepositoryCloneUrlsFromCreateOutput(result.stdout, input.repository),
        ),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headSelector,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GitHubCli, make);
