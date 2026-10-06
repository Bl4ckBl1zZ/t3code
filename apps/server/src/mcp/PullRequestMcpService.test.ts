import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { updateLinkedPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { make, resolvePullRequestTarget } from "./PullRequestMcpService.ts";

const threadId = ThreadId.make("owner-thread");
const projectId = ProjectId.make("owner-project");
const scope: McpInvocationScope = {
  credentialId: "credential",
  environmentId: EnvironmentId.make("env"),
  threadId,
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["pull-requests"]),
  audience: "urn:t3-code:mcp:env",
  issuedAt: 1,
};

it.effect("links, lists, and unlinks only the credential's thread without host writes", () =>
  Effect.gen(function* () {
    let thread = {
      id: threadId,
      projectId,
      deletedAt: null,
      pullRequests: [],
    } as unknown as OrchestrationV2ThreadShell;
    const commands: OrchestrationV2ServerCommand[] = [];
    const layer = Layer.mergeAll(
      Layer.mock(ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.sync(() => {
            expect(id).toBe(threadId);
            return thread;
          }),
        dispatch: (command) =>
          Effect.sync(() => {
            if (command.type !== "thread.metadata.update")
              throw new Error("Expected V2 metadata update");
            expect(command.threadId).toBe(threadId);
            commands.push(command);
            thread = {
              ...thread,
              ...updateLinkedPullRequests(thread, command, "2026-09-11T00:00:00.000Z"),
            };
            return { sequence: commands.length, storedEvents: [] };
          }),
      }),
      Layer.mock(ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
      NodeServices.layer,
    );
    const service = yield* make.pipe(Effect.provide(layer));
    const input = { url: "https://github.com/org/repo/pull/41" };
    expect((yield* service.link(scope, input)).alreadyLinked).toBe(false);
    expect((yield* service.link(scope, input)).alreadyLinked).toBe(true);
    expect(commands).toHaveLength(1);
    expect((yield* service.list(scope, {})).pullRequests).toMatchObject([
      { number: 41, source: "agent", state: null },
    ]);
    expect((yield* service.unlink(scope, input)).wasLinked).toBe(true);
    expect((yield* service.unlink(scope, input)).wasLinked).toBe(false);
    expect(commands).toHaveLength(2);
    expect((yield* service.list(scope, {})).pullRequests).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("requires the PR capability before touching thread state", () =>
  Effect.gen(function* () {
    const service = yield* make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagementService)({
            getThreadShell: () => Effect.die("Must not read thread"),
          }),
          Layer.mock(ProjectService)({}),
          NodeServices.layer,
        ),
      ),
    );
    const result = yield* service
      .link(
        { ...scope, capabilities: new Set(["orchestration"]) },
        { url: "https://github.com/org/repo/pull/41" },
      )
      .pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "McpPullRequestCapabilityUnavailableError" },
    });
  }).pipe(Effect.scoped),
);

it.effect("resolves host-specific URLs and refuses incomplete or non-PR targets", () =>
  Effect.gen(function* () {
    const gitlab = yield* resolvePullRequestTarget(
      { url: "https://gitlab.example/team/sub/repo/-/merge_requests/17" },
      undefined,
    );
    expect(gitlab).toMatchObject({
      host: "gitlab.example",
      repository: "team/sub/repo",
      number: 17,
    });
    const azure = yield* resolvePullRequestTarget(
      { url: "https://dev.azure.com/org/project/_git/repo/pullrequest/8" },
      undefined,
    );
    expect(azure).toMatchObject({
      host: "dev.azure.com",
      repository: "org/project/_git/repo",
      number: 8,
    });
    expect(
      yield* resolvePullRequestTarget(
        { url: "https://github.com/org/repo/issues/41" },
        undefined,
      ).pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure" });
    expect(
      yield* resolvePullRequestTarget({ repository: "org/repo", number: 41 }, undefined).pipe(
        Effect.result,
      ),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "PullRequestHostRequiredError" } });
  }),
);

const watchHarness = (
  pullRequests: ReadonlyArray<unknown>,
  relationshipToParent: "subagent" | null = null,
) =>
  Effect.gen(function* () {
    const thread = {
      id: threadId,
      projectId,
      deletedAt: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent },
      pullRequests,
    } as unknown as OrchestrationV2ThreadShell;
    const commands: OrchestrationV2ServerCommand[] = [];
    const service = yield* make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagementService)({
            getThreadShell: () => Effect.succeed(thread),
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: commands.length, storedEvents: [] };
              }),
          }),
          Layer.mock(ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
          NodeServices.layer,
        ),
      ),
    );
    return { service, commands };
  });

const watchedLink = (number: number, overrides: Record<string, unknown> = {}) => ({
  host: "github.com",
  repository: "t3tools/t3code",
  number,
  url: `https://github.com/t3tools/t3code/pull/${number}`,
  source: "agent",
  linkedAt: "2026-08-20T00:00:00.000Z",
  snapshot: null,
  stack: null,
  ...overrides,
});

it.effect("watching an unlinked pull request links it first", () =>
  Effect.gen(function* () {
    const { service, commands } = yield* watchHarness([]);
    const result = yield* service.setWatching(
      scope,
      { url: "https://github.com/t3tools/t3code/pull/9" },
      true,
    );
    // The harness thread never changes, so the result reports what it still holds.
    expect(result).toMatchObject({ number: 9, watching: false, wasWatching: false });
    expect(commands).toMatchObject([
      {
        type: "thread.pull-request.watch",
        number: 9,
        watching: true,
        link: { url: "https://github.com/t3tools/t3code/pull/9", source: "agent" },
      },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("refuses to watch a merged pull request and stops an existing watch", () =>
  Effect.gen(function* () {
    const watch = {
      startedAt: "2026-08-20T00:00:00.000Z",
      headSha: null,
      failedChecks: [],
      passed: false,
      passedChecks: [],
      remarksThrough: "2026-08-20T00:00:00.000Z",
      remarkIds: [],
      conflicting: false,
      wakes: 0,
    };
    const snapshot = (state: string) => ({
      state,
      title: "PR",
      headBranch: "feature",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-08-20T00:00:00.000Z",
    });
    const { service, commands } = yield* watchHarness([
      watchedLink(1, { snapshot: snapshot("merged") }),
      watchedLink(3, { snapshot: snapshot("open"), watch }),
    ]);
    const error = yield* service
      .setWatching(scope, { url: "https://github.com/t3tools/t3code/pull/1" }, true)
      .pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "PullRequestNotOpenError", state: "merged" });
    expect(
      yield* service.setWatching(scope, { url: "https://github.com/t3tools/t3code/pull/3" }, false),
    ).toMatchObject({ wasWatching: true });
    expect(commands).toMatchObject([
      { type: "thread.pull-request.watch", number: 3, watching: false },
    ]);
    expect((yield* service.list(scope, {})).pullRequests).toMatchObject([
      { number: 1, watching: false },
      { number: 3, watching: true },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("changes another thread's pull requests only within the caller's modes", () =>
  Effect.gen(function* () {
    const otherThreadId = ThreadId.make("other-thread");
    const shells = new Map<string, OrchestrationV2ThreadShell>([
      [
        threadId,
        {
          id: threadId,
          projectId,
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          activeRunId: "run-live",
          archivedAt: null,
          providerInstanceId: "codex",
          deletedAt: null,
          pullRequests: [],
        } as unknown as OrchestrationV2ThreadShell,
      ],
      [
        otherThreadId,
        {
          id: otherThreadId,
          projectId: ProjectId.make("other-project"),
          runtimeMode: "full-access",
          interactionMode: "default",
          deletedAt: null,
          pullRequests: [],
        } as unknown as OrchestrationV2ThreadShell,
      ],
    ]);
    const commands: OrchestrationV2ServerCommand[] = [];
    const service = yield* make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: commands.length, storedEvents: [] };
              }),
          }),
          Layer.mock(ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
          NodeServices.layer,
        ),
      ),
    );
    const input = { threadId: otherThreadId, url: "https://github.com/org/repo/pull/41" };
    const refused = yield* service.link(scope, input).pipe(Effect.flip);
    expect(refused).toMatchObject({ _tag: "PullRequestThreadAboveLimitsError" });
    // Reading another thread's links needs no write access.
    expect((yield* service.list(scope, { threadId: otherThreadId })).pullRequests).toEqual([]);

    shells.set(otherThreadId, {
      ...shells.get(otherThreadId)!,
      runtimeMode: "approval-required",
    });
    expect((yield* service.link(scope, input)).alreadyLinked).toBe(false);
    expect(commands).toMatchObject([{ type: "thread.metadata.update", threadId: otherThreadId }]);
  }).pipe(Effect.scoped),
);

it.effect("watches a pull request saved as closed, since it may have reopened", () =>
  Effect.gen(function* () {
    const { service, commands } = yield* watchHarness([
      watchedLink(1, {
        snapshot: {
          state: "closed",
          title: "PR",
          headBranch: "feature",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-08-20T00:00:00.000Z",
        },
      }),
    ]);
    yield* service.setWatching(scope, { url: "https://github.com/t3tools/t3code/pull/1" }, true);
    expect(commands).toMatchObject([
      { type: "thread.pull-request.watch", number: 1, watching: true },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("refuses a watch from a subagent thread, whose parent owns the pull request", () =>
  Effect.gen(function* () {
    const { service, commands } = yield* watchHarness([watchedLink(1)], "subagent");
    const error = yield* service
      .setWatching(scope, { url: "https://github.com/t3tools/t3code/pull/1" }, true)
      .pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "PullRequestWatchFromSubagentError" });
    expect(commands).toEqual([]);
  }).pipe(Effect.scoped),
);
