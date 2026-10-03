import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { ProjectServiceLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { createNewProject } from "./NewProject.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const enrichmentLayer = ProjectEnrichmentService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
);

// Real git and a real ProjectService over a fresh in-memory database.
const TestLayer = Layer.mergeAll(
  ProjectServiceLayerLive.pipe(
    Layer.provide(enrichmentLayer),
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(SqlitePersistenceMemory),
  ),
  GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer)),
).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-new-project-" })),
  Layer.provideMerge(NodeServices.layer),
);

const GIT_ENV_KEYS = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "EMAIL",
] as const;

const TEST_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

// Git reads the developer's own config (signing, default branch, identity)
// unless the test replaces it, so each test runs against an empty one.
const withGitEnv = <A, E, R>(
  env: Partial<Record<(typeof GIT_ENV_KEYS)[number], string>>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const emptyConfig = yield* fileSystem.makeTempFileScoped({ prefix: "t3-gitconfig-" });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const saved = GIT_ENV_KEYS.map((key) => [key, process.env[key]] as const);
        for (const key of GIT_ENV_KEYS) delete process.env[key];
        Object.assign(process.env, {
          GIT_CONFIG_GLOBAL: emptyConfig,
          GIT_CONFIG_NOSYSTEM: "1",
          ...env,
        });
        return saved;
      }),
      () => effect,
      (saved) =>
        Effect.sync(() => {
          for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }),
    );
  });

const makeRoot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return path.join(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-projects-" }),
    "projects",
  );
});

const gitOutput = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* git.execute({ operation: "NewProject.test", cwd, args });
    return result.stdout.trim();
  });

it.effect("starts a project as a committed repository, and suffixes a taken name", () =>
  withGitEnv(
    TEST_IDENTITY,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projects = yield* ProjectService.ProjectService;
      const root = yield* makeRoot;

      const first = yield* createNewProject({ root, name: "Pinball Stats" });
      const second = yield* createNewProject({ root, name: "pinball stats" });

      assert.equal(first.workspaceRoot, path.join(root, "pinball-stats"));
      assert.equal(second.workspaceRoot, path.join(root, "pinball-stats-2"));
      assert.isUndefined(first.commitError);
      const project = Option.getOrThrow(yield* projects.getById(first.projectId));
      assert.equal(project.title, "Pinball Stats");
      assert.equal(project.workspaceRoot, first.workspaceRoot);
      const readme = yield* fileSystem.readFileString(path.join(first.workspaceRoot, "README.md"));
      assert.include(readme, "# Pinball Stats");
      assert.include(readme, `src="assets/icon.svg"`);
      const icon = yield* fileSystem.readFileString(
        path.join(first.workspaceRoot, "assets", "icon.svg"),
      );
      assert.include(icon, ">PS</text>");
      assert.equal(yield* gitOutput(first.workspaceRoot, ["log", "--format=%s"]), "Initial commit");
      assert.equal(
        yield* gitOutput(first.workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
        "main",
      );
      assert.equal(yield* gitOutput(first.workspaceRoot, ["status", "--porcelain"]), "");
    }),
  ).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("keeps the project and reports why when Git cannot commit", () =>
  // No identity anywhere, and Git may not guess one from the host name.
  withGitEnv(
    {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.useConfigOnly",
      GIT_CONFIG_VALUE_0: "true",
    },
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projects = yield* ProjectService.ProjectService;
      const root = yield* makeRoot;

      const result = yield* createNewProject({ root, name: "No Identity" });

      assert.include(result.commitError ?? "", "no name or email");
      assert.isTrue(Option.isSome(yield* projects.getById(result.projectId)));
      assert.isTrue(yield* fileSystem.exists(path.join(result.workspaceRoot, "README.md")));
      assert.isTrue(yield* fileSystem.exists(path.join(result.workspaceRoot, ".git")));
    }),
  ).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("keeps a folder that another project owns when the create conflicts", () =>
  withGitEnv(
    TEST_IDENTITY,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projects = yield* ProjectService.ProjectService;
      const root = yield* makeRoot;
      const taken = path.join(root, "taken");
      // A project registered at this path some other way (by hand, or a
      // client that predates the claim) owns the folder the create claims.
      yield* projects.create({
        commandId: CommandId.make("command:owner"),
        projectId: ProjectId.make("project:owner"),
        title: "Owner",
        workspaceRoot: taken,
        createWorkspaceRootIfMissing: true,
      });
      yield* fileSystem.remove(taken, { recursive: true });

      const failure = yield* Effect.flip(createNewProject({ root, name: "Taken" }));

      assert.equal(failure._tag, "ProjectProvisionError");
      assert.isTrue(yield* fileSystem.exists(path.join(taken, "README.md")));
      const owner = yield* projects.getByWorkspaceRoot(taken);
      assert.equal(Option.getOrThrow(owner).id, ProjectId.make("project:owner"));
      assert.deepEqual(yield* fileSystem.readDirectory(root), ["taken"]);
    }),
  ).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("removes the folder when the project create is rejected for another reason", () =>
  withGitEnv(
    TEST_IDENTITY,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* makeRoot;

      const failure = yield* Effect.flip(
        createNewProject({ root, name: "Rejected" }).pipe(
          // A real ProjectService cannot be made to fail its store on demand.
          Effect.updateService(ProjectService.ProjectService, (real) => ({
            ...real,
            create: (input) =>
              Effect.fail(
                new ProjectService.ProjectOperationError({
                  operation: "dispatch-project-command",
                  projectId: input.projectId,
                  cause: "store unavailable",
                }),
              ),
          })),
        ),
      );

      assert.equal(failure._tag, "ProjectProvisionError");
      assert.deepEqual(yield* fileSystem.readDirectory(root), []);
    }),
  ).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("removes the folder when the create is cancelled before the project exists", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const projects = yield* ProjectService.ProjectService;
    const root = yield* makeRoot;
    const scaffolding = yield* Deferred.make<void>();

    const fiber = yield* createNewProject({ root, name: "Cancelled" }).pipe(
      // Holds `git init` open so the create can be interrupted mid-scaffold.
      Effect.updateService(GitVcsDriver.GitVcsDriver, (real) => ({
        ...real,
        readConfigValue: () => Effect.succeed(null),
        execute: () => Deferred.succeed(scaffolding, undefined).pipe(Effect.andThen(Effect.never)),
      })),
      Effect.forkChild,
    );
    yield* Deferred.await(scaffolding);
    assert.deepEqual(yield* fileSystem.readDirectory(root), ["cancelled"]);
    yield* Fiber.interrupt(fiber);

    assert.deepEqual(yield* fileSystem.readDirectory(root), []);
    assert.deepEqual((yield* projects.snapshot).projects, []);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
