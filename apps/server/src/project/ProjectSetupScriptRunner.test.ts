import { assert, it, vi } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerSettingsService } from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

for (const mode of ["legacy", "inherit-empty", "inherit-reset", "disabled"] as const) {
  it.effect(`resolves ${mode} setup actions through the standalone project service`, () => {
    const open = vi.fn((input: Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0]) =>
      Effect.succeed({
        threadId: input.threadId,
        terminalId: input.terminalId,
        cwd: input.cwd,
        worktreePath: input.worktreePath ?? null,
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "Shell",
        updatedAt: "2026-06-20T00:00:00.000Z",
      }),
    );
    const write = vi.fn(
      (_input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) => Effect.void,
    );
    const projectId = ProjectId.make("project:setup-runner-v2");
    const project = {
      id: projectId,
      title: "Project",
      workspaceRoot: "/repo",
      repositoryIdentity: null,
      faviconPath: null,
      defaultModelSelection: null,
      scripts: [
        {
          id: "setup",
          name: "Setup",
          command: "vp install",
          icon: "configure" as const,
          runOnWorktreeCreate: true,
        },
      ],
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
      deletedAt: null,
    };
    const defaultScript = {
      ...project.scripts[0]!,
      id: "machine",
      name: "Machine setup",
      command: "echo setup",
    };
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultProjectScripts: [defaultScript],
      projectScriptOverrides:
        mode === "inherit-reset"
          ? { [projectId]: null }
          : mode === "disabled"
            ? { [projectId]: [] }
            : {},
    };
    const currentProject = { ...project, scripts: mode === "inherit-empty" ? [] : project.scripts };
    const layer = ProjectSetupScriptRunner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeed(Option.some(currentProject)),
          }),
          Layer.mock(TerminalManager.TerminalManager)({ open, write }),
          Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(settings) }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId,
        worktreePath: "/repo-worktree",
      });
      if (mode === "disabled") {
        assert.deepEqual(result, { status: "no-script" });
        assert.equal(open.mock.calls.length, 0);
        assert.equal(write.mock.calls.length, 0);
        return;
      }
      const expected = mode === "legacy" ? project.scripts[0]! : defaultScript;
      assert.deepEqual(result, {
        status: "started",
        scriptId: expected.id,
        scriptName: expected.name,
        terminalId: `setup-${expected.id}`,
        cwd: "/repo-worktree",
      });
      assert.equal(open.mock.calls[0]?.[0].cwd, "/repo-worktree");
      assert.equal(write.mock.calls[0]?.[0].data, `${expected.command}\r`);
    }).pipe(Effect.provide(layer));
  });
}
