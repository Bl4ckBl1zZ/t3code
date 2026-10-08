import { ProjectId, type ProjectScript } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  projectScriptRuntimeEnv,
  resolveProjectScripts,
  settleProjectScript,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as TerminalManager from "../terminal/Manager.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export interface ProjectSetupScriptRunnerResultStarted {
  readonly status: "started";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly terminalId: string;
  readonly cwd: string;
  /**
   * Resolves when the script's shell prints the completion sentinel. The
   * exit code is null when the terminal exited or was closed before the
   * sentinel arrived. Only present when `observeCompletion` was requested.
   * An exit code of 0 closes the script's shell if it has nothing left running.
   */
  readonly completion?: Effect.Effect<ProjectSetupScriptCompletion>;
}

export interface ProjectSetupScriptCompletion {
  readonly exitCode: number | null;
  readonly durationMs: number;
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultStarted;

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
  readonly preferredTerminalId?: string;
  /** Which project script to run. Defaults to the worktree setup script. */
  readonly trigger?: "setup" | "settle";
  readonly project?: {
    readonly id: ProjectId;
    readonly workspaceRoot: string;
    readonly scripts: ReadonlyArray<ProjectScript>;
  };
  /**
   * Wrap the command so the shell reports its exit code back through the
   * terminal stream. The settle action uses this to close its shell after a
   * clean run.
   */
  readonly observeCompletion?: boolean;
}

export class ProjectSetupScriptOperationError extends Schema.TaggedErrorClass<ProjectSetupScriptOperationError>()(
  "ProjectSetupScriptOperationError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    operation: Schema.Literals(["resolveProject", "readSettings", "openTerminal", "writeCommand"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project setup script operation '${this.operation}' failed for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export class ProjectSetupScriptProjectNotFoundError extends Schema.TaggedErrorClass<ProjectSetupScriptProjectNotFoundError>()(
  "ProjectSetupScriptProjectNotFoundError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
  },
) {
  override get message(): string {
    return `Project was not found for setup script execution for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export const ProjectSetupScriptRunnerError = Schema.Union([
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
]);
export type ProjectSetupScriptRunnerError = typeof ProjectSetupScriptRunnerError.Type;

export class ProjectSetupScriptRunner extends Context.Service<
  ProjectSetupScriptRunner,
  {
    readonly runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
  }
>()("t3/project/ProjectSetupScriptRunner") {}

/**
 * Marker the wrapped command echoes so the exit code can be read from the PTY
 * stream. Each run gets its own random token so script output cannot spoof
 * completion, and the sentinel pattern is built per run from it.
 */
const COMPLETION_SENTINEL_PREFIX = "__T3_SETUP_DONE__";
/** A partial line longer than this is a byte stream, not a line. Keep only the tail. */
const PARTIAL_LINE_MAX_LENGTH = 4_096;

function completionSentinel(token: string): string {
  return `${COMPLETION_SENTINEL_PREFIX}_${token}:`;
}

function completionSentinelPattern(token: string): RegExp {
  return new RegExp(`${COMPLETION_SENTINEL_PREFIX}_${token}:(-?\\d+)`);
}

type CompletionShell = "posix" | "fish" | "powershell";

/**
 * Predicts the shell TerminalManager will spawn for the script terminal. The
 * manager takes `$SHELL` on POSIX and PowerShell on Windows, falling back to
 * other shells only when that one fails to spawn.
 */
function resolveCompletionShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): CompletionShell {
  if (platform === "win32") return "powershell";
  const shell = env.SHELL ?? "";
  const name = shell.split("/").at(-1) ?? shell;
  if (name === "fish") return "fish";
  if (name === "pwsh" || name === "powershell") return "powershell";
  return "posix";
}

/**
 * Builds the shell input for an observed script. The command runs inside a
 * block and the block closes on its own line, so a trailing `# comment` or a
 * heredoc terminator in the command cannot swallow the sentinel. The shell
 * reads the whole block before running any of it, so a script that reads
 * stdin cannot consume the sentinel line either. Lines are separated by `\r`
 * because that is the Enter key for every shell's line editor.
 */
function wrapCommandForCompletion(
  command: string,
  shell: CompletionShell,
  sentinel: string,
): string {
  const body = command.replace(/\r?\n/g, "\r");
  switch (shell) {
    case "powershell":
      return `$global:LASTEXITCODE = $null; & {\r${body}\r}; if ($null -ne $LASTEXITCODE) { $__t3c = $LASTEXITCODE } elseif ($?) { $__t3c = 0 } else { $__t3c = 1 }; Write-Host "${sentinel}$__t3c"`;
    case "fish":
      return `begin\r${body}\rend; printf '\\n${sentinel}%s\\n' $status`;
    case "posix":
      return `( ${body}\r); printf '\\n${sentinel}%s\\n' "$?"`;
  }
}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettingsService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const crypto = yield* Crypto.Crypto;
  const completionShell = resolveCompletionShell(
    yield* HostProcessPlatform,
    yield* HostProcessEnvironment,
  );

  /**
   * Watches the script terminal for the completion sentinel. Terminal output
   * is a byte stream, so partial lines are buffered until a newline. The
   * subscription is torn down once the sentinel, an exit, or a close arrives.
   */
  const observeTerminalCompletion = (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly sentinelPattern: RegExp;
  }) =>
    Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis;
      const done = yield* Deferred.make<ProjectSetupScriptCompletion>();
      // The shell redraws its prompt just after the sentinel. Closing before
      // that would read the redraw as new activity and keep an idle shell.
      const promptReturned = yield* Deferred.make<void>();
      let lineBuffer = "";
      let settled = false;

      const settle = (exitCode: number | null) =>
        Effect.suspend(() => {
          if (settled) return Effect.void;
          settled = true;
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap((nowMs) =>
              Deferred.succeed(done, { exitCode, durationMs: nowMs - startedAtMs }),
            ),
            Effect.asVoid,
          );
        });

      const handleLine = (rawLine: string) =>
        Effect.suspend(() => {
          const sentinel = input.sentinelPattern.exec(rawLine);
          if (!sentinel) return Effect.void;
          const parsed = Number(sentinel[1]);
          return settle(Number.isFinite(parsed) ? parsed : null);
        });

      const unsubscribe = yield* terminalManager.subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
          return Effect.void;
        }
        if (event.type === "output") {
          lineBuffer += event.data;
          const lines = lineBuffer.split(/\r\n|\r|\n/);
          lineBuffer = lines.pop() ?? "";
          // A script that never prints a newline must not grow this forever.
          // The sentinel is always on its own line, so keeping the tail is safe.
          if (lineBuffer.length > PARTIAL_LINE_MAX_LENGTH) {
            lineBuffer = lineBuffer.slice(-PARTIAL_LINE_MAX_LENGTH);
          }
          return Effect.forEach(lines, handleLine, { discard: true }).pipe(
            // A prompt has no newline, so it is what remains once the sentinel is in.
            Effect.andThen(
              Effect.suspend(() =>
                settled && lineBuffer.length > 0
                  ? Deferred.succeed(promptReturned, undefined).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            ),
          );
        }
        if (event.type === "exited" || event.type === "closed") {
          return settle(null).pipe(Effect.andThen(Deferred.succeed(promptReturned, undefined)));
        }
        return Effect.void;
      });

      const completion = Deferred.await(done).pipe(
        // A shell with an empty prompt never prints one; do not wait forever.
        Effect.tap(() => Deferred.await(promptReturned).pipe(Effect.timeoutOption("1 second"))),
        Effect.ensuring(Effect.sync(() => unsubscribe())),
      );
      return { completion, unsubscribe };
    });

  const runForThread: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runForThread",
  )(function* (input) {
    const errorContext = {
      threadId: input.threadId,
      worktreePath: input.worktreePath,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
    };
    const suppliedProject = input.project;
    const projectById =
      suppliedProject ??
      (input.projectId
        ? yield* projects.getById(ProjectId.make(input.projectId)).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(
              (cause) =>
                new ProjectSetupScriptOperationError({
                  ...errorContext,
                  operation: "resolveProject",
                  cause,
                }),
            ),
          )
        : null);
    const project =
      suppliedProject ??
      projectById ??
      (input.projectCwd
        ? yield* projects.getByWorkspaceRoot(input.projectCwd).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(
              (cause) =>
                new ProjectSetupScriptOperationError({
                  ...errorContext,
                  operation: "resolveProject",
                  cause,
                }),
            ),
          )
        : null);

    if (!project) {
      return yield* new ProjectSetupScriptProjectNotFoundError(errorContext);
    }

    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ProjectSetupScriptOperationError({
            ...errorContext,
            operation: "readSettings",
            cause,
          }),
      ),
    );
    const trigger = input.trigger ?? "setup";
    const scripts = resolveProjectScripts(settings, project);
    const script =
      trigger === "settle" ? settleProjectScript(scripts) : setupProjectScript(scripts);
    if (!script) {
      return {
        status: "no-script",
      } as const;
    }

    // A thread settles again after it is resumed, and an earlier settle shell
    // may still be busy; typing into it would feed its foreground program.
    const terminalId =
      input.preferredTerminalId ??
      (trigger === "settle"
        ? `settle-${script.id}-${(yield* crypto.randomUUIDv4.pipe(Effect.orDie)).slice(0, 8)}`
        : `setup-${script.id}`);
    const cwd = input.worktreePath;
    const env = projectScriptRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath: input.worktreePath,
    });
    const completionToken = input.observeCompletion
      ? (yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "")
      : null;
    const commandLine =
      completionToken === null
        ? script.command
        : wrapCommandForCompletion(
            script.command,
            completionShell,
            completionSentinel(completionToken),
          );

    yield* terminalManager
      .open({
        threadId: input.threadId,
        terminalId,
        cwd,
        worktreePath: input.worktreePath,
        // Setup may run before a terminal client attaches to answer color probes.
        env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "openTerminal",
              cause,
            }),
        ),
      );
    // Subscribe before writing so the sentinel cannot race past the listener.
    const observed =
      completionToken === null
        ? undefined
        : yield* observeTerminalCompletion({
            threadId: input.threadId,
            terminalId,
            sentinelPattern: completionSentinelPattern(completionToken),
          });
    yield* terminalManager
      .write({
        threadId: input.threadId,
        terminalId,
        data: `${commandLine}\r`,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "writeCommand",
              cause,
            }),
        ),
        // Nothing will ever settle the completion if the command never ran.
        Effect.tapError(() => Effect.sync(() => observed?.unsubscribe())),
      );

    // A clean run leaves only an idle prompt behind; its output stays in the
    // terminal history. A failed run keeps its shell open for a look.
    const completion = observed?.completion.pipe(
      Effect.tap(({ exitCode }) =>
        exitCode === 0
          ? terminalManager.closeIdle({ threadId: input.threadId, terminalId })
          : Effect.void,
      ),
    );

    return {
      status: "started",
      scriptId: script.id,
      scriptName: script.name,
      terminalId,
      cwd,
      ...(completion ? { completion } : {}),
    } as const;
  });

  return ProjectSetupScriptRunner.of({ runForThread });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
