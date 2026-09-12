import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
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
    const commands: OrchestrationV2Command[] = [];
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
    expect((yield* service.list(scope)).pullRequests).toMatchObject([
      { number: 41, source: "agent", state: null },
    ]);
    expect((yield* service.unlink(scope, input)).wasLinked).toBe(true);
    expect((yield* service.unlink(scope, input)).wasLinked).toBe(false);
    expect(commands).toHaveLength(2);
    expect((yield* service.list(scope)).pullRequests).toEqual([]);
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
