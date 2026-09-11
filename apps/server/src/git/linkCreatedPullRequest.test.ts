import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  type Project,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2Command,
  type GitRunStackedActionResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { updateLinkedPullRequests } from "@t3tools/shared/threadPullRequests";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { createdPullRequestKey, withCreatedPullRequestLink } from "./linkCreatedPullRequest.ts";

const project: Project = {
  id: ProjectId.make("project"),
  title: "Fork",
  workspaceRoot: "/checkout",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:00:00Z",
  deletedAt: null,
};
const result: GitRunStackedActionResult = {
  action: "create_pr",
  branch: { status: "skipped_not_requested" },
  commit: { status: "skipped_not_requested" },
  push: { status: "skipped_not_requested" },
  pr: { status: "created", number: 42, url: "https://github.com/upstream/repo/pull/42" },
  toast: { title: "Created PR", cta: { kind: "none" } },
};

it("uses the target URL identity and rejects inconsistent numbers and non-PR actions", () => {
  expect(createdPullRequestKey(result.pr, project)).toEqual({
    host: "github.com",
    repository: "upstream/repo",
    number: 42,
  });
  expect(createdPullRequestKey({ ...result.pr, number: 43 }, project)).toBeNull();
  expect(
    createdPullRequestKey({ ...result.pr, status: "skipped_not_requested" }, project),
  ).toBeNull();
});

it("supports a configured self-hosted GitHub URL without accepting another host or repository", () => {
  const enterprise = {
    ...project,
    repositoryIdentity: {
      canonicalKey: "code.example.com/acme/repo",
      provider: "github",
      owner: "acme",
      name: "repo",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://code.example.com/acme/repo.git",
      },
    },
  };
  expect(
    createdPullRequestKey(
      { ...result.pr, url: "https://code.example.com/acme/repo/pull/42" },
      enterprise,
    ),
  ).toEqual({ host: "code.example.com", repository: "acme/repo", number: 42 });
  for (const url of [
    "https://other.example.com/acme/repo/pull/42",
    "https://code.example.com/wrong/repo/pull/42",
    "javascript:alert(42)",
  ]) {
    expect(createdPullRequestKey({ ...result.pr, url }, enterprise)).toBeNull();
  }
});

for (const change of [
  "none",
  "new-branch",
  "moved",
  "branch-changed",
  "missing",
  "dispatch-failure",
] as const) {
  it.effect(`keeps the git result and links only the original thread context: ${change}`, () =>
    Effect.gen(function* () {
      let thread = {
        id: ThreadId.make("thread"),
        projectId: project.id,
        worktreePath: null,
        branch: "feature",
        archivedAt: null,
        deletedAt: null,
        pullRequests: [],
      } as unknown as OrchestrationV2ThreadShell;
      const commands: OrchestrationV2Command[] = [];
      const layer = Layer.mergeAll(
        Layer.mock(ThreadManagementService)({
          getThreadShell: () => Effect.succeed(change === "missing" ? null : thread),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              if (change === "dispatch-failure") throw new Error("Thread was concurrently deleted");
              if (command.type === "thread.metadata.update")
                thread = {
                  ...thread,
                  ...updateLinkedPullRequests(thread, command, project.updatedAt),
                };
              return { sequence: commands.length, storedEvents: [] };
            }),
        }),
        Layer.mock(ProjectService)({
          snapshot: Effect.succeed({ projects: [project], updatedAt: project.updatedAt }),
        }),
        NodeServices.layer,
      );
      const completed =
        change === "new-branch"
          ? { ...result, branch: { status: "created" as const, name: "feature/new" } }
          : result;
      const action = Effect.sync(() => {
        if (change === "moved") thread = { ...thread, worktreePath: "/elsewhere" };
        if (change === "branch-changed") thread = { ...thread, branch: "unrelated" };
        if (change === "new-branch") thread = { ...thread, branch: "feature/new" };
        return completed;
      });
      const input = {
        actionId: "create-42",
        action: "create_pr" as const,
        threadId: thread.id,
        cwd: project.workspaceRoot,
      };
      expect(yield* withCreatedPullRequestLink(input, action).pipe(Effect.provide(layer))).toBe(
        completed,
      );
      if (change === "none" || change === "new-branch" || change === "dispatch-failure") {
        expect(commands[0]).toMatchObject({
          type: "thread.metadata.update",
          expectedProjectId: project.id,
          expectedWorktreePath: null,
          expectedBranch: change === "new-branch" ? "feature/new" : "feature",
          linkPullRequestSource: "created",
          linkPullRequest: { repository: "upstream/repo", number: 42 },
        });
        if (change !== "dispatch-failure") {
          yield* withCreatedPullRequestLink(input, Effect.succeed(completed)).pipe(
            Effect.provide(layer),
          );
          expect(thread.pullRequests).toHaveLength(1);
          expect(thread.pullRequests?.[0]?.source).toBe("created");
        }
      } else expect(commands).toEqual([]);
    }),
  );
}
