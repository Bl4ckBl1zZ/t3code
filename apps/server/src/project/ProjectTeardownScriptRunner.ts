/**
 * ProjectTeardownScriptRunner - runs a project's teardown script (the one
 * flagged `runOnWorktreeDelete`) inside a worktree right before that
 * worktree is removed.
 *
 * Execution is best-effort and headless: unlike the setup script, there is
 * no thread terminal to attach to at removal time, so the command runs as a
 * bounded child process and failures are logged without blocking removal.
 *
 * @module ProjectTeardownScriptRunner
 */
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { projectScriptRuntimeEnv, teardownProjectScript } from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProcessRunner } from "../processRunner.ts";
import * as ProjectService from "./ProjectService.ts";

const TEARDOWN_SCRIPT_TIMEOUT = Duration.minutes(2);

export interface ProjectTeardownScriptRunnerInput {
  /** Workspace root of the project owning the worktree. */
  readonly projectCwd: string;
  /** The worktree that is about to be removed; the script's cwd. */
  readonly worktreePath: string;
}

export class ProjectTeardownScriptRunner extends Context.Service<
  ProjectTeardownScriptRunner,
  {
    /**
     * Run the project's teardown script in the worktree, waiting for it to
     * finish (bounded by a timeout). Never fails: missing projects, missing
     * scripts, and script failures are logged and swallowed so worktree
     * removal always proceeds.
     */
    readonly runForWorktree: (input: ProjectTeardownScriptRunnerInput) => Effect.Effect<void>;
  }
>()("t3/project/ProjectTeardownScriptRunner") {}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const processRunner = yield* ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;

  const runForWorktree: ProjectTeardownScriptRunner["Service"]["runForWorktree"] = Effect.fn(
    "ProjectTeardownScriptRunner.runForWorktree",
  )(
    function* (input) {
      const project = yield* projects
        .getByWorkspaceRoot(input.projectCwd)
        .pipe(Effect.map(Option.getOrUndefined));
      if (!project) {
        return;
      }
      const script = teardownProjectScript(project.scripts);
      if (!script) {
        return;
      }
      const worktreeExists = yield* fileSystem.exists(input.worktreePath);
      if (!worktreeExists) {
        return;
      }

      const env = projectScriptRuntimeEnv({
        project: { cwd: project.workspaceRoot },
        worktreePath: input.worktreePath,
      });
      const platform = yield* HostProcessPlatform;
      const shell =
        platform === "win32"
          ? { command: "cmd", args: ["/d", "/s", "/c", script.command] }
          : { command: "/bin/sh", args: ["-c", script.command] };

      yield* Effect.logInfo("Running project teardown script before worktree removal.", {
        projectId: project.id,
        scriptId: script.id,
        worktreePath: input.worktreePath,
      });
      const result = yield* processRunner.run({
        command: shell.command,
        args: shell.args,
        cwd: input.worktreePath,
        env,
        timeout: TEARDOWN_SCRIPT_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        outputMode: "truncate",
      });
      if (result.timedOut || (result.code !== null && result.code !== 0)) {
        yield* Effect.logWarning("Project teardown script did not finish cleanly.", {
          projectId: project.id,
          scriptId: script.id,
          worktreePath: input.worktreePath,
          exitCode: result.code,
          timedOut: result.timedOut,
          stderr: result.stderr,
        });
      }
    },
    Effect.ignoreCause({ log: true }),
  );

  return ProjectTeardownScriptRunner.of({ runForWorktree });
});

export const layer = Layer.effect(ProjectTeardownScriptRunner, make);
