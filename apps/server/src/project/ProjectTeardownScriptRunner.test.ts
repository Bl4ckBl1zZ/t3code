import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, type ProjectScript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectTeardownScriptRunner from "./ProjectTeardownScriptRunner.ts";

const runTeardown = (scripts: ReadonlyArray<ProjectScript>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const worktree = yield* fs.makeTempDirectoryScoped({ prefix: "teardown-worktree-" });
    const project = {
      id: ProjectId.make("project:teardown"),
      title: "Project",
      workspaceRoot: "/repo",
      repositoryIdentity: null,
      faviconPath: null,
      defaultModelSelection: null,
      scripts,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
      deletedAt: null,
    };
    const runner = yield* ProjectTeardownScriptRunner.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService)({
            getByWorkspaceRoot: (root) =>
              Effect.succeed(root === "/repo" ? Option.some(project) : Option.none()),
          }),
          ServerSettings.layerTest(),
          ProcessRunner.layer,
        ),
      ),
    );
    const failure = yield* runner.runBeforeRemoval({ projectCwd: "/repo", worktreePath: worktree });
    const ranPath = `${worktree}/ran.txt`;
    const ran = (yield* fs.exists(ranPath)) ? yield* fs.readFileString(ranPath) : null;
    return { failure, ran, worktree: yield* fs.realPath(worktree) };
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const teardown = (command: string): ProjectScript => ({
  id: "teardown",
  name: "Stop services",
  command,
  icon: "configure",
  runOnWorktreeCreate: false,
  runOnWorktreeDelete: true,
});

it.live("runs the teardown script in the worktree with the project script environment", () =>
  Effect.gen(function* () {
    const { failure, ran, worktree } = yield* runTeardown([
      teardown(`printf '%s|%s|%s' "$T3CODE_PROJECT_ROOT" "$T3CODE_WORKTREE_PATH" "$PWD" > ran.txt`),
    ]);
    assert.equal(failure, null);
    const [root, worktreeEnv, cwd] = (ran ?? "").split("|");
    assert.equal(root, "/repo");
    assert.ok(worktreeEnv);
    assert.equal(cwd, worktree);
  }),
);

it.live("reports a failing teardown script with its exit code and output tail", () =>
  Effect.gen(function* () {
    const { failure } = yield* runTeardown([teardown("echo stopping; echo nope >&2; exit 3")]);
    assert.deepEqual(failure, {
      scriptName: "Stop services",
      exitCode: 3,
      timedOut: false,
      detail: "nope",
    });
  }),
);

it.live("does nothing when the project has no teardown script", () =>
  Effect.gen(function* () {
    const { failure } = yield* runTeardown([{ ...teardown("exit 1"), runOnWorktreeDelete: false }]);
    assert.equal(failure, null);
  }),
);
