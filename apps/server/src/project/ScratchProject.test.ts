import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  type Project,
  type ProjectIconOverride,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectService from "./ProjectService.ts";
import {
  claimScratchThreadFolder,
  ensureScratchProject,
  SCRATCH_PROJECT_ICON,
} from "./ScratchProject.ts";

const makeProject = (id: ProjectId, workspaceRoot: string): Project => ({
  id,
  title: "No project",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
  deletedAt: null,
});

const unused = () => Effect.die("unused in this test");

const projectServiceStub = (
  service: Pick<
    ProjectService.ProjectService["Service"],
    "create" | "update" | "getByWorkspaceRoot"
  >,
) =>
  ProjectService.ProjectService.of({
    ...service,
    bootstrap: unused,
    delete: unused,
    getById: unused,
    snapshot: Effect.die("unused in this test"),
  });

const commandId = (step: string) => CommandId.make(`cmd-scratch-${step}`);

it.layer(NodeServices.layer)("ScratchProject", (it) => {
  it.effect("gives each new Scratch thread its own folder", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const scratchRoot = path.join(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-scratch-" }),
        "scratch",
      );
      const createdAt = "2026-09-25T10:00:00.000Z";
      const text = "Convert these PNGs to WebP, please!";
      // The second id shares the first's short prefix, the third tries to
      // climb out of the Scratch root, and the fourth pastes a long token.
      const starts = [
        { id: "a1b2c3d4-scratch-thread", text },
        { id: "a1b2c3d4-other", text },
        { id: "../../escape", text },
        { id: "f00dcafe-long", text: "x".repeat(300) },
      ];
      const folders: Array<string> = [];
      for (const start of starts) {
        folders.push(
          yield* claimScratchThreadFolder({
            scratchRoot,
            threadId: ThreadId.make(start.id),
            createdAt,
            text: start.text,
          }),
        );
      }

      const names = folders.map((folder) => path.basename(folder));
      assert.equal(names[0], "2026-09-25-convert-these-pngs-to-webp-a1b2c3d4");
      assert.equal(names[1], "2026-09-25-convert-these-pngs-to-webp-a1b2c3d4other");
      assert.equal(names[2], "2026-09-25-convert-these-pngs-to-webp-escape");
      assert.equal(names[3], `2026-09-25-${"x".repeat(48)}-f00dcafe`);
      for (const folder of folders) {
        assert.equal(path.dirname(folder), scratchRoot);
        assert.isTrue(yield* fileSystem.exists(folder));
      }
    }).pipe(Effect.scoped),
  );

  it.effect("creates the Scratch project once and restores its folder on reuse", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const scratchRoot = path.join(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-scratch-" }),
        "scratch",
      );
      const created: Array<Project> = [];
      const iconUpdates: Array<ProjectIconOverride | null | undefined> = [];
      const projects = projectServiceStub({
        create: (input) =>
          Effect.sync(() => {
            const project = makeProject(input.projectId, input.workspaceRoot);
            created.push(project);
            return project;
          }),
        update: (input) =>
          Effect.sync(() => {
            iconUpdates.push(input.projectIcon);
            return created[0]!;
          }),
        getByWorkspaceRoot: (workspaceRoot) =>
          Effect.succeed(
            Option.fromNullishOr(
              created.find((project) => project.workspaceRoot === workspaceRoot),
            ),
          ),
      });
      const ensure = (projectId: string) =>
        ensureScratchProject({
          workspaceRoot: scratchRoot,
          projectId: ProjectId.make(projectId),
          commandId,
        }).pipe(Effect.provideService(ProjectService.ProjectService, projects));

      const first = yield* ensure("project-scratch-1");
      // A user may delete the folder; reuse must bring it back.
      yield* fileSystem.remove(scratchRoot, { recursive: true });
      const second = yield* ensure("project-scratch-2");

      assert.equal(created.length, 1);
      assert.equal(first, ProjectId.make("project-scratch-1"));
      assert.equal(second, first);
      // The icon is set once, at create.
      assert.deepEqual(iconUpdates, [SCRATCH_PROJECT_ICON]);
      assert.isTrue(yield* fileSystem.exists(scratchRoot));
    }).pipe(Effect.scoped),
  );

  it.effect("resolves a lost Scratch create race to the winning project", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const scratchRoot = path.join(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-scratch-" }),
        "scratch",
      );
      const winnerId = ProjectId.make("project-scratch-winner");
      let lookups = 0;
      const projects = projectServiceStub({
        create: (input) =>
          Effect.fail(
            new ProjectService.ProjectConflictError({
              projectId: input.projectId,
              workspaceRoot: input.workspaceRoot,
              conflictingProjectId: winnerId,
            }),
          ),
        update: unused,
        // Empty before the create, then the other client's project.
        getByWorkspaceRoot: (workspaceRoot) =>
          Effect.sync(() =>
            lookups++ === 0 ? Option.none() : Option.some(makeProject(winnerId, workspaceRoot)),
          ),
      });

      const result = yield* ensureScratchProject({
        workspaceRoot: scratchRoot,
        projectId: ProjectId.make("project-scratch-loser"),
        commandId,
      }).pipe(Effect.provideService(ProjectService.ProjectService, projects));

      assert.equal(result, winnerId);
    }).pipe(Effect.scoped),
  );
});
