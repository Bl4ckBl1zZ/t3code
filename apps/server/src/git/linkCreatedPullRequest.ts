import {
  CommandId,
  pullRequestHostOf,
  type Project,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
} from "@t3tools/contracts";
import { changeRequestUrlFor, parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import * as Cause from "effect/Cause";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";

/** Prefer the host URL over the checkout remote, including pull requests opened against an upstream fork. */
export function createdPullRequestKey(pr: GitRunStackedActionResult["pr"], project: Project) {
  if ((pr.status !== "created" && pr.status !== "opened_existing") || !pr.url) return null;
  const parsed = parseChangeRequestUrl(pr.url);
  if (parsed !== null)
    return pr.number === undefined || pr.number === parsed.number ? parsed : null;
  const identity = project.repositoryIdentity;
  const kind = identity?.provider;
  const repository = sourceControlRepositorySelector(identity);
  if (
    !identity ||
    !repository ||
    pr.number === undefined ||
    (kind !== "github" && kind !== "gitlab" && kind !== "bitbucket" && kind !== "azure-devops")
  )
    return null;
  const host = pullRequestHostOf(identity, kind);
  const expected = changeRequestUrlFor(kind, host, repository, pr.number);
  if (expected === null) return null;
  try {
    const url = new URL(pr.url);
    const expectedUrl = new URL(expected);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.hostname.toLowerCase() !== expectedUrl.hostname.toLowerCase() ||
      url.pathname.replace(/\/$/u, "").toLowerCase() !== expectedUrl.pathname.toLowerCase()
    )
      return null;
    return {
      host: url.hostname.toLowerCase(),
      repository: repository.toLowerCase(),
      number: pr.number,
    };
  } catch {
    return null;
  }
}

/** Link a successful create/open action without turning a bookkeeping failure into a failed git action. */
export const withCreatedPullRequestLink = <E, R>(
  input: GitRunStackedActionInput,
  action: Effect.Effect<GitRunStackedActionResult, E, R>,
) =>
  Effect.gen(function* () {
    const threadId = input.threadId;
    if (threadId === undefined) return yield* action;
    const threads = yield* ThreadManagementService;
    const projects = yield* ProjectService;
    const path = yield* Path.Path;
    const recover = (cause: Cause.Cause<unknown>) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("created pull request could not be linked", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null));
    const before = yield* Effect.gen(function* () {
      const thread = yield* threads.getThreadShell(threadId);
      if (thread === null || thread.deletedAt !== null || thread.archivedAt !== null) return null;
      const project = (yield* projects.snapshot).projects.find(
        (project) => project.id === thread.projectId,
      );
      if (
        project === undefined ||
        path.resolve(thread.worktreePath ?? project.workspaceRoot) !== path.resolve(input.cwd)
      )
        return null;
      return { thread, project };
    }).pipe(Effect.catchCause(recover));

    const result = yield* action;
    if (
      before === null ||
      (result.pr.status !== "created" && result.pr.status !== "opened_existing") ||
      !result.pr.url
    )
      return result;
    const key = createdPullRequestKey(result.pr, before.project);
    if (key === null || (result.pr.number !== undefined && key.number !== result.pr.number))
      return result;
    const url = result.pr.url;
    yield* Effect.gen(function* () {
      const current = yield* threads.getThreadShell(before.thread.id);
      if (
        current === null ||
        current.deletedAt !== null ||
        current.archivedAt !== null ||
        current.projectId !== before.thread.projectId ||
        current.worktreePath !== before.thread.worktreePath
      )
        return;
      const project = (yield* projects.snapshot).projects.find(
        (project) => project.id === current.projectId,
      );
      if (project === undefined || project.workspaceRoot !== before.project.workspaceRoot) return;
      // A feature-branch action may have already updated the client's saved branch.
      if (current.branch !== before.thread.branch && current.branch !== result.branch.name) return;
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`pr-created-link:${input.actionId}`),
        threadId: before.thread.id,
        expectedProjectId: current.projectId,
        expectedWorktreePath: current.worktreePath,
        expectedBranch: current.branch,
        linkPullRequest: { ...key, projectId: current.projectId, url },
        linkPullRequestSource: "created",
      });
    }).pipe(Effect.catchCause(recover));
    return result;
  });
