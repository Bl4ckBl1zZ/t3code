import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type Project, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ScratchProject from "./ScratchProject.ts";

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

const testLayer = (input: {
  readonly isRepository?: boolean;
  readonly projects: Partial<ProjectService.ProjectService["Service"]>;
}) =>
  Layer.mergeAll(
    Layer.mock(GitWorkflowService.GitWorkflowService)({
      isRepository: () => Effect.succeed(input.isRepository ?? false),
    }),
    Layer.mock(ProjectService.ProjectService)(input.projects),
  );

const makeBaseDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-scratch-" });
});

it.layer(NodeServices.layer)("ScratchProject", (it) => {
  it.effect("creates the Scratch project once and restores its folder on reuse", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* makeBaseDir;
      const created: Array<Project> = [];
      const iconUpdates: Array<unknown> = [];
      const scratch = yield* ScratchProject.make(baseDir).pipe(
        Effect.provide(
          testLayer({
            projects: {
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
            },
          }),
        ),
      );

      const scratchRoot = (yield* scratch.workspaceRoot) ?? "";
      const first = yield* scratch.ensureProject;
      // A user may delete the folder; reuse must bring it back.
      yield* fileSystem.remove(scratchRoot, { recursive: true });
      const second = yield* scratch.ensureProject;

      assert.isTrue(scratchRoot.endsWith("scratch"));
      assert.equal(created.length, 1);
      assert.equal(created[0]?.workspaceRoot, scratchRoot);
      assert.equal(first.projectId, created[0]?.id);
      assert.equal(second.projectId, first.projectId);
      // The icon is set once, at create.
      assert.deepEqual(iconUpdates, [
        { kind: "lucide", name: "message-square-dashed", color: "gray" },
      ]);
      assert.isTrue(yield* fileSystem.exists(scratchRoot));
    }).pipe(Effect.scoped),
  );

  it.effect("resolves a lost Scratch create race to the winning project", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir;
      const winnerId = ProjectId.make("project-scratch-winner");
      let lookups = 0;
      const scratch = yield* ScratchProject.make(baseDir).pipe(
        Effect.provide(
          testLayer({
            projects: {
              create: (input) =>
                Effect.fail(
                  new ProjectService.ProjectConflictError({
                    projectId: input.projectId,
                    workspaceRoot: input.workspaceRoot,
                    conflictingProjectId: winnerId,
                  }),
                ),
              // Empty before the create, then the other client's project.
              getByWorkspaceRoot: (workspaceRoot) =>
                Effect.sync(() =>
                  lookups++ === 0
                    ? Option.none()
                    : Option.some(makeProject(winnerId, workspaceRoot)),
                ),
            },
          }),
        ),
      );

      const result = yield* scratch.ensureProject;
      assert.equal(result.projectId, winnerId);
    }).pipe(Effect.scoped),
  );

  it.effect("gives each new Scratch thread its own folder", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* makeBaseDir;
      const scratchProjectId = ProjectId.make("project-scratch");
      const otherProjectId = ProjectId.make("project-other");
      const scratchRoot = path.resolve(baseDir, "scratch");
      const scratch = yield* ScratchProject.make(baseDir).pipe(
        Effect.provide(
          testLayer({
            projects: {
              getById: (projectId) =>
                Effect.succeed(
                  projectId === scratchProjectId
                    ? Option.some(makeProject(scratchProjectId, scratchRoot))
                    : Option.some(makeProject(otherProjectId, path.join(baseDir, "repo"))),
                ),
            },
          }),
        ),
      );

      // The second id shares the first's short prefix, the third tries to
      // climb out of the scratch root, and the fourth pastes a long token.
      const text = "Convert these PNGs to WebP, please!";
      const starts = [
        { id: "a1b2c3d4-scratch-thread", text },
        { id: "a1b2c3d4-other", text },
        { id: "../../escape", text },
        { id: "f00dcafe-long", text: "x".repeat(300) },
      ];
      const folders: Array<string> = [];
      for (const start of starts) {
        const folder = yield* scratch.threadFolder({
          projectId: scratchProjectId,
          threadId: ThreadId.make(start.id),
          text: start.text,
        });
        folders.push(folder ?? "");
      }

      // The date is the server's receipt time.
      const names = folders.map((folder) => path.basename(folder));
      assert.match(names[0] ?? "", /^\d{4}-\d{2}-\d{2}-convert-these-pngs-to-webp-a1b2c3d4$/);
      assert.match(names[1] ?? "", /-convert-these-pngs-to-webp-a1b2c3d4other$/);
      assert.match(names[2] ?? "", /-convert-these-pngs-to-webp-escape$/);
      assert.match(names[3] ?? "", /^\d{4}-\d{2}-\d{2}-x{48}-f00dcafe$/);
      for (const folder of folders) {
        assert.equal(path.dirname(folder), scratchRoot);
        assert.isTrue(yield* fileSystem.exists(folder));
      }
      // Threads in any other project keep their workspace.
      assert.isNull(
        yield* scratch.threadFolder({
          projectId: otherProjectId,
          threadId: ThreadId.make("thread-elsewhere"),
          text,
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("launches new Scratch threads into their own folder and leaves others alone", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseDir = yield* makeBaseDir;
      const scratchProjectId = ProjectId.make("project-scratch");
      const otherProjectId = ProjectId.make("project-other");
      const scratchRoot = path.resolve(baseDir, "scratch");
      const scratch = yield* ScratchProject.make(baseDir).pipe(
        Effect.provide(
          testLayer({
            projects: {
              getById: (projectId) =>
                Effect.succeed(
                  Option.some(
                    projectId === scratchProjectId
                      ? makeProject(scratchProjectId, scratchRoot)
                      : makeProject(otherProjectId, path.join(baseDir, "repo")),
                  ),
                ),
            },
          }),
        ),
      );
      const launch = (overrides: Partial<Parameters<typeof scratch.launchWorkspaceStrategy>[0]>) =>
        scratch.launchWorkspaceStrategy({
          projectId: scratchProjectId,
          threadId: ThreadId.make("thread-launch"),
          workspaceStrategy: { type: "root" },
          text: "Sort my photos",
          ...overrides,
        });

      const fromRoot = yield* launch({});
      // A plain folder cannot host a worktree, so that request lands in one too.
      const fromWorktree = yield* launch({
        threadId: ThreadId.make("thread-worktree"),
        workspaceStrategy: { type: "worktree", baseRef: "main" },
      });
      const existing = { type: "existing_worktree", worktreePath: "/kept" } as const;

      assert.equal(fromRoot.type, "existing_worktree");
      assert.equal(fromWorktree.type, "existing_worktree");
      if (fromRoot.type === "existing_worktree") {
        assert.equal(path.dirname(fromRoot.worktreePath), scratchRoot);
        assert.match(path.basename(fromRoot.worktreePath), /-sort-my-photos-threadla$/);
      }
      assert.deepEqual(yield* launch({ workspaceStrategy: existing }), existing);
      assert.deepEqual(yield* launch({ reuseExistingThread: true }), { type: "root" });
      assert.deepEqual(yield* launch({ projectId: otherProjectId }), { type: "root" });
    }).pipe(Effect.scoped),
  );

  it.effect("withholds Scratch when the data dir sits inside a work tree", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir;
      const scratch = yield* ScratchProject.make(baseDir).pipe(
        Effect.provide(testLayer({ isRepository: true, projects: {} })),
      );

      const ensure = yield* Effect.flip(scratch.ensureProject);

      assert.isUndefined(yield* scratch.workspaceRoot);
      assert.include(ensure.message, "not available");
      assert.isNull(
        yield* scratch.threadFolder({
          projectId: ProjectId.make("project-scratch"),
          threadId: ThreadId.make("thread-1"),
          text: "hello",
        }),
      );
    }).pipe(Effect.scoped),
  );
});
