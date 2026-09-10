import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  GitManagerError,
  ProjectId,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { autoPullProjects } from "../serverRuntimeStartup.ts";
import { ProjectService } from "./ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";

const project = (id: string, workspaceRoot: string): Project => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
  deletedAt: null,
});

it.effect(
  "startup deduplicates enabled workspaces, honors explicit off, and continues after failures",
  () => {
    const refreshed: string[] = [];
    return autoPullProjects.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              defaultAutoPull: true,
              projectAutoPullOverrides: { [ProjectId.make("off")]: false },
            }),
          }),
          Layer.mock(ProjectService)({
            snapshot: Effect.succeed({
              projects: [
                project("one", "/same"),
                project("two", "/same"),
                project("bad", "/failed"),
                project("off", "/off"),
                project("three", "/next"),
              ],
              updatedAt: "2026-09-10T00:00:00.000Z",
            }),
          }),
          Layer.mock(VcsStatusBroadcaster)({
            refreshStatus: (cwd) =>
              Effect.sync(() => {
                refreshed.push(cwd);
              }).pipe(
                Effect.andThen(
                  cwd === "/failed"
                    ? Effect.fail(
                        new GitManagerError({ operation: "refresh", cwd, detail: "offline" }),
                      )
                    : Effect.succeed({
                        isRepo: false,
                        hasPrimaryRemote: false,
                        isDefaultRef: false,
                        refName: null,
                        hasWorkingTreeChanges: false,
                        workingTree: { files: [], insertions: 0, deletions: 0 },
                        hasUpstream: false,
                        aheadCount: 0,
                        behindCount: 0,
                        pr: null,
                      }),
                ),
              ),
          }),
        ),
      ),
      Effect.tap(() =>
        Effect.sync(() => assert.deepStrictEqual(refreshed.sort(), ["/failed", "/next", "/same"])),
      ),
    );
  },
);

it.effect("startup performs no project or Git reads when all automatic pulls are off", () =>
  autoPullProjects.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) }),
        Layer.mock(ProjectService)({ snapshot: Effect.die("must not scan projects") }),
        Layer.mock(VcsStatusBroadcaster)({ refreshStatus: () => Effect.die("must not read Git") }),
      ),
    ),
  ),
);
