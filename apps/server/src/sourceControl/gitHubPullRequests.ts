import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  PositiveInt,
  TrimmedNonEmptyString,
  type ChangeRequestCheckSummary,
  type ChangeRequestMergeStatus,
} from "@t3tools/contracts";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";

export interface NormalizedGitHubPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<DateTime.Utc>;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
  readonly mergeStatus?: ChangeRequestMergeStatus;
  readonly checks?: ChangeRequestCheckSummary;
}

const GitHubPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.Boolean),
  statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.String,
      }),
    ),
  ),
  headRepositoryOwner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.String,
      }),
    ),
  ),
});

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeGitHubPullRequestState(input: {
  state?: string | null | undefined;
  mergedAt?: string | null | undefined;
}): "open" | "closed" | "merged" {
  const normalizedState = input.state?.trim().toUpperCase();
  if (
    (typeof input.mergedAt === "string" && input.mergedAt.trim().length > 0) ||
    normalizedState === "MERGED"
  ) {
    return "merged";
  }
  if (normalizedState === "CLOSED") {
    return "closed";
  }
  return "open";
}

function normalizeGitHubMergeStatus(
  raw: Pick<
    Schema.Schema.Type<typeof GitHubPullRequestSchema>,
    "isDraft" | "mergeable" | "mergeStateStatus"
  >,
): ChangeRequestMergeStatus | undefined {
  const mergeable = raw.mergeable?.trim().toUpperCase();
  const mergeStateStatus = raw.mergeStateStatus?.trim().toUpperCase();

  if (raw.isDraft) return "draft";
  if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") return "conflicting";
  if (mergeStateStatus === "BEHIND") return "behind";
  if (mergeStateStatus === "BLOCKED") return "blocked";
  if (mergeStateStatus === "UNSTABLE") return "unstable";
  if (mergeable === "MERGEABLE" || mergeStateStatus === "CLEAN") return "mergeable";
  if (mergeable || mergeStateStatus) return "unknown";
  return undefined;
}

function getRecordString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value.trim().toUpperCase() : null;
}

function normalizeGitHubCheckSummary(
  rollup: ReadonlyArray<unknown> | null | undefined,
): ChangeRequestCheckSummary | undefined {
  if (!rollup || rollup.length === 0) {
    return undefined;
  }

  const summary = {
    total: 0,
    completed: 0,
    successful: 0,
    failed: 0,
    pending: 0,
  };

  for (const item of rollup) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const typename = getRecordString(record, "__typename");
    const state = getRecordString(record, "state");

    if (typename === "STATUSCONTEXT" || (state && !getRecordString(record, "status"))) {
      if (!state) continue;
      summary.total += 1;
      if (state === "SUCCESS") {
        summary.completed += 1;
        summary.successful += 1;
      } else if (state === "FAILURE" || state === "ERROR") {
        summary.completed += 1;
        summary.failed += 1;
      } else {
        summary.pending += 1;
      }
      continue;
    }

    const status = getRecordString(record, "status");
    const conclusion = getRecordString(record, "conclusion");
    if (!status && !conclusion) {
      continue;
    }

    summary.total += 1;
    if (status === "COMPLETED" || conclusion) {
      summary.completed += 1;
      if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") {
        summary.successful += 1;
      } else {
        summary.failed += 1;
      }
    } else {
      summary.pending += 1;
    }
  }

  return summary.total > 0 ? summary : undefined;
}

function normalizeGitHubPullRequestRecord(
  raw: Schema.Schema.Type<typeof GitHubPullRequestSchema>,
): NormalizedGitHubPullRequestRecord {
  const headRepositoryNameWithOwner = trimOptionalString(raw.headRepository?.nameWithOwner);
  const headRepositoryOwnerLogin =
    trimOptionalString(raw.headRepositoryOwner?.login) ??
    (typeof headRepositoryNameWithOwner === "string" && headRepositoryNameWithOwner.includes("/")
      ? (headRepositoryNameWithOwner.split("/")[0] ?? null)
      : null);
  const mergeStatus = normalizeGitHubMergeStatus(raw);
  const checks = normalizeGitHubCheckSummary(raw.statusCheckRollup);

  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    state: normalizeGitHubPullRequestState(raw),
    updatedAt: raw.updatedAt ?? Option.none(),
    ...(typeof raw.isCrossRepository === "boolean"
      ? { isCrossRepository: raw.isCrossRepository }
      : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
    ...(mergeStatus ? { mergeStatus } : {}),
    ...(checks ? { checks } : {}),
  };
}

const decodeGitHubPullRequestList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeGitHubPullRequest = decodeJsonResult(GitHubPullRequestSchema);
const decodeGitHubPullRequestEntry = Schema.decodeUnknownExit(GitHubPullRequestSchema);

export const formatGitHubJsonDecodeError = formatSchemaError;

export function decodeGitHubPullRequestListJson(
  raw: string,
): Result.Result<
  ReadonlyArray<NormalizedGitHubPullRequestRecord>,
  Cause.Cause<Schema.SchemaError>
> {
  const result = decodeGitHubPullRequestList(raw);
  if (Result.isSuccess(result)) {
    const pullRequests: NormalizedGitHubPullRequestRecord[] = [];
    for (const entry of result.success) {
      const decodedEntry = decodeGitHubPullRequestEntry(entry);
      if (Exit.isFailure(decodedEntry)) {
        continue;
      }
      pullRequests.push(normalizeGitHubPullRequestRecord(decodedEntry.value));
    }
    return Result.succeed(pullRequests);
  }
  return Result.fail(result.failure);
}

export function decodeGitHubPullRequestJson(
  raw: string,
): Result.Result<NormalizedGitHubPullRequestRecord, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGitHubPullRequest(raw);
  if (Result.isSuccess(result)) {
    return Result.succeed(normalizeGitHubPullRequestRecord(result.success));
  }
  return Result.fail(result.failure);
}
