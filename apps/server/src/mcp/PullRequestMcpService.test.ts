import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  PullRequestOperationError,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type Project,
  type PullRequestRef,
  type PullRequestReviewGuideResult,
} from "@t3tools/contracts";
import { updateLinkedPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { PullRequestReviewGuideService } from "../pullRequest/PullRequestReviewGuideService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { make, resolvePullRequestTarget } from "./PullRequestMcpService.ts";

const threadId = ThreadId.make("owner-thread");
const projectId = ProjectId.make("owner-project");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("env"),
  requestNamespace: "session",
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["pull-requests"]),
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
      Layer.mock(PullRequestReviewGuideService)({}),
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
          Layer.mock(PullRequestReviewGuideService)({}),
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
          Layer.mock(PullRequestReviewGuideService)({}),
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

const project = (id: string, canonicalKey: string, provider: string): Project =>
  ({
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/repo/${id}`,
    repositoryIdentity: {
      canonicalKey,
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${canonicalKey}` },
      provider,
      displayName: canonicalKey.split("/").slice(1).join("/"),
      owner: canonicalKey.split("/")[1],
      name: canonicalKey.split("/").at(-1),
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
    deletedAt: null,
  }) as Project;

const NO_GUIDE: PullRequestReviewGuideResult = { guide: null, run: null, currentHeadSha: "head-1" };
const STARTED = {
  ...NO_GUIDE,
  run: { _tag: "Running" as const, headSha: "head-1", startedAt: "2026-10-11T00:00:00.000Z" },
  started: true,
};

/** The caller's thread is in `owner-project`, a checkout of github.com/t3tools/t3code. */
const guideHarness = (options: {
  readonly projects?: ReadonlyArray<Project>;
  readonly generate?: (
    input: PullRequestRef,
  ) => Effect.Effect<
    PullRequestReviewGuideResult & { started: boolean },
    PullRequestOperationError
  >;
}) =>
  Effect.gen(function* () {
    const guideRequests = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
    const own = project("owner-project", "github.com/t3tools/t3code", "github");
    const service = yield* make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                id: threadId,
                projectId,
                deletedAt: null,
              } as unknown as OrchestrationV2ThreadShell),
          }),
          Layer.mock(ProjectService)({
            snapshot: Effect.succeed({
              projects: options.projects ?? [own],
              updatedAt: "2026-10-11T00:00:00.000Z",
            }),
          }),
          Layer.mock(PullRequestReviewGuideService)({
            get: () => Effect.succeed(NO_GUIDE),
            generate: (input) =>
              Ref.update(guideRequests, (recorded) => [...recorded, input]).pipe(
                Effect.andThen(options.generate?.(input) ?? Effect.succeed(STARTED)),
              ),
          }),
          NodeServices.layer,
        ),
      ),
    );
    return { service, guideRequests, own };
  });

it.effect(
  "writes guides through the project whose checkout is each pull request's repository",
  () =>
    Effect.gen(function* () {
      const own = project("owner-project", "github.com/t3tools/t3code", "github");
      const web = project("project-web", "github.com/acme/web", "github");
      const { service, guideRequests } = yield* guideHarness({ projects: [own, web] });
      const result = yield* service.writeGuides(scope, {
        pullRequests: [
          { url: "https://github.com/acme/web/pull/7" },
          { repository: "t3tools/t3code", number: 12 },
          { url: "https://github.com/someone/else/pull/1" },
        ],
      });
      expect(result.guides.map((guide) => [guide.repository, guide.number, guide.outcome])).toEqual(
        [
          ["acme/web", 7, "started"],
          ["t3tools/t3code", 12, "started"],
          ["someone/else", 1, "failed"],
        ],
      );
      expect(result.guides[2]?.detail).toContain("No project in this environment");
      expect((yield* Ref.get(guideRequests)).map((ref) => [ref.projectId, ref.number])).toEqual([
        ["project-web", 7],
        [projectId, 12],
      ]);
    }).pipe(Effect.scoped),
);

it.effect("reports a refused guide on its own pull request without failing the rest", () =>
  Effect.gen(function* () {
    const { service } = yield* guideHarness({
      generate: (input) =>
        input.number === 1
          ? Effect.fail(
              new PullRequestOperationError({
                operation: "generateReviewGuide",
                detail: "Review guides are off. Turn them on in Settings → Source Control.",
              }),
            )
          : Effect.succeed(STARTED),
    });
    const result = yield* service.writeGuides(scope, {
      pullRequests: [
        { repository: "t3tools/t3code", number: 1 },
        { repository: "t3tools/t3code", number: 2 },
      ],
    });
    expect(result.guides.map((guide) => [guide.number, guide.outcome, guide.detail])).toEqual([
      [1, "failed", "Review guides are off. Turn them on in Settings → Source Control."],
      [2, "started", null],
    ]);
  }).pipe(Effect.scoped),
);

it.effect("reports an unreadable entry on its own and still writes the rest of the batch", () =>
  Effect.gen(function* () {
    const { service, guideRequests } = yield* guideHarness({});
    const result = yield* service.writeGuides(scope, {
      pullRequests: [
        { url: "https://example.com/not-a-pull-request" },
        { repository: "t3tools/t3code" },
        { repository: "t3tools/t3code", number: 5 },
      ],
    });
    expect(result.guides.map((guide) => guide.outcome)).toEqual(["failed", "failed", "started"]);
    expect(result.guides[0]?.detail).toContain("not a recognised pull request URL");
    expect(result.guides[1]?.detail).toContain("Pass either url");
    expect((yield* Ref.get(guideRequests)).map((ref) => ref.number)).toEqual([5]);
  }).pipe(Effect.scoped),
);

it.effect("reports a run the guide service joined as running, not as a new one", () =>
  Effect.gen(function* () {
    const { service } = yield* guideHarness({
      generate: () => Effect.succeed({ ...STARTED, started: false }),
    });
    const result = yield* service.writeGuides(scope, {
      pullRequests: [{ repository: "t3tools/t3code", number: 4 }],
    });
    expect(result.guides.map((guide) => guide.outcome)).toEqual(["running"]);
  }).pipe(Effect.scoped),
);

it.effect("finds an Azure DevOps checkout for a pull request named by its full path", () =>
  Effect.gen(function* () {
    const own = project("owner-project", "github.com/t3tools/t3code", "github");
    const azure = project("project-azure", "dev.azure.com/org/project/_git/web", "azure-devops");
    const { service, guideRequests } = yield* guideHarness({ projects: [own, azure] });
    const result = yield* service.writeGuides(scope, {
      pullRequests: [{ host: "dev.azure.com", repository: "org/project/_git/web", number: 9 }],
    });
    expect(result.guides.map((guide) => guide.outcome)).toEqual(["started"]);
    expect((yield* Ref.get(guideRequests)).map((ref) => ref.projectId)).toEqual(["project-azure"]);
  }).pipe(Effect.scoped),
);

it.effect("reads a stored guide and says when a push left it behind", () =>
  Effect.gen(function* () {
    const { service } = yield* guideHarness({});
    const result = yield* service.readGuide(scope, { repository: "t3tools/t3code", number: 3 });
    expect(result).toMatchObject({ number: 3, guide: null, run: null, stale: false });
  }).pipe(Effect.scoped),
);

it.effect("requires the PR capability before writing a guide", () =>
  Effect.gen(function* () {
    const { service, guideRequests } = yield* guideHarness({});
    const result = yield* service
      .writeGuides(
        { ...scope, capabilities: new Set(["orchestration"]) },
        { pullRequests: [{ repository: "t3tools/t3code", number: 1 }] },
      )
      .pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "McpPullRequestCapabilityUnavailableError" },
    });
    expect(yield* Ref.get(guideRequests)).toEqual([]);
  }).pipe(Effect.scoped),
);
