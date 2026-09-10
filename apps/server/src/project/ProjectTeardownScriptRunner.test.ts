import { assert, it, vi } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type Project,
  type ProjectScript,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ProcessRunner } from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectService } from "./ProjectService.ts";
import * as Runner from "./ProjectTeardownScriptRunner.ts";

for (const disabled of [false, true]) {
  it.effect(`resolves inherited teardown before worktree removal (disabled=${disabled})`, () => {
    const id = ProjectId.make("teardown-project");
    const project: Project = {
      id,
      title: "Project",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
      deletedAt: null,
    };
    const action: ProjectScript = {
      id: "teardown",
      name: "Teardown",
      command: "echo teardown",
      icon: "configure",
      runOnWorktreeCreate: false,
      runOnWorktreeDelete: true,
    };
    const run = vi.fn((_input: Parameters<ProcessRunner["Service"]["run"]>[0]) =>
      Effect.succeed({
        code: ChildProcessSpawner.ExitCode(0),
        stdout: "",
        stderr: "",
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
    );
    const layer = Runner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectService)({
            getByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
          }),
          Layer.mock(ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              defaultProjectScripts: [action],
              projectScriptOverrides: disabled ? { [id]: [] } : {},
            }),
          }),
          Layer.mock(ProcessRunner)({ run }),
          FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const runner = yield* Runner.ProjectTeardownScriptRunner;
      yield* runner.runForWorktree({ projectCwd: "/repo", worktreePath: "/repo-worktree" });
      assert.equal(run.mock.calls.length, disabled ? 0 : 1);
      if (!disabled) {
        assert.equal(run.mock.calls[0]?.[0].cwd, "/repo-worktree");
        assert.isTrue(run.mock.calls[0]?.[0].args?.includes("echo teardown"));
        assert.equal(run.mock.calls[0]?.[0].timeoutBehavior, "timedOutResult");
      }
    }).pipe(Effect.provide(layer));
  });
}
