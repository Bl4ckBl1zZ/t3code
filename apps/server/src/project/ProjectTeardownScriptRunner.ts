/**
 * ProjectTeardownScriptRunner - runs the project script flagged
 * `runOnWorktreeDelete` inside a worktree right before T3 Code removes it.
 *
 * Every removal path calls this: `GitWorkflowService.removeWorktree` (thread
 * deletion, bulk delete, abandoned launches and MCP handoff rollbacks) and
 * storage cleanup. There is no thread terminal to attach to at that point, so
 * the command runs headless with a timeout. It never fails: a failure is
 * returned for the caller to surface, and removal proceeds either way.
 *
 * @module ProjectTeardownScriptRunner
 */
import type { WorktreeTeardownFailure } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  projectScriptRuntimeEnv,
  resolveProjectScripts,
  teardownProjectScript,
} from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";

const TEARDOWN_TIMEOUT = "2 minutes";
const DETAIL_MAX_LINES = 5;
const DETAIL_MAX_LENGTH = 1_000;

export interface ProjectTeardownScriptInput {
  /** Workspace root of the project that owns the worktree. */
  readonly projectCwd: string;
  /** The worktree about to be removed; the script's cwd. */
  readonly worktreePath: string;
}

export class ProjectTeardownScriptRunner extends Context.Service<
  ProjectTeardownScriptRunner,
  {
    /**
     * Run the project's teardown script and wait for it. Resolves to the
     * failure to report, or null when there was no script or it exited 0.
     */
    readonly runBeforeRemoval: (
      input: ProjectTeardownScriptInput,
    ) => Effect.Effect<WorktreeTeardownFailure | null>;
  }
>()("t3/project/ProjectTeardownScriptRunner") {}

function outputTail(stdout: string, stderr: string): string {
  const text = stderr.trim().length > 0 ? stderr : stdout;
  return text.trim().split(/\r?\n/).slice(-DETAIL_MAX_LINES).join("\n").slice(-DETAIL_MAX_LENGTH);
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const hostEnv = yield* HostProcess.Environment;
  const shell =
    platform === "win32"
      ? { command: hostEnv.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"] }
      : { command: hostEnv.SHELL || "/bin/sh", args: ["-c"] };

  const runBeforeRemoval: ProjectTeardownScriptRunner["Service"]["runBeforeRemoval"] = Effect.fn(
    "ProjectTeardownScriptRunner.runBeforeRemoval",
  )(function* (input) {
    const project = Option.getOrUndefined(
      yield* projects
        .getByWorkspaceRoot(input.projectCwd)
        .pipe(Effect.orElseSucceed(() => Option.none())),
    );
    if (!project) return null;
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings === null) return null;
    const script = teardownProjectScript(resolveProjectScripts(settings, project));
    if (!script) return null;
    if (!(yield* fileSystem.exists(input.worktreePath).pipe(Effect.orElseSucceed(() => false)))) {
      return null;
    }

    yield* Effect.logInfo("Running project teardown script before worktree removal", {
      projectId: project.id,
      scriptId: script.id,
      worktreePath: input.worktreePath,
    });
    const failure = (exitCode: number | null, timedOut: boolean, detail: string) =>
      ({ scriptName: script.name, exitCode, timedOut, detail }) satisfies WorktreeTeardownFailure;
    const result = yield* processRunner
      .run({
        command: shell.command,
        args: [...shell.args, script.command],
        cwd: input.worktreePath,
        env: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: input.worktreePath,
        }),
        timeout: TEARDOWN_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((output) =>
          output.timedOut || output.code !== 0
            ? failure(
                output.timedOut ? null : output.code,
                output.timedOut,
                outputTail(output.stdout, output.stderr),
              )
            : null,
        ),
        Effect.catch((error) => Effect.succeed(failure(null, false, error.message))),
      );
    if (result !== null) {
      yield* Effect.logWarning("Project teardown script did not finish cleanly", {
        projectId: project.id,
        scriptId: script.id,
        worktreePath: input.worktreePath,
        ...result,
      });
    }
    return result;
  });

  return ProjectTeardownScriptRunner.of({ runBeforeRemoval });
});

export const layer = Layer.effect(ProjectTeardownScriptRunner, make);
