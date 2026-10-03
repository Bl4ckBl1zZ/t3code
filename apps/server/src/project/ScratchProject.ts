/**
 * ScratchProject - the home of threads without a project.
 *
 * One project per environment, rooted at `<data dir>/scratch` and shown to
 * users as "No project". Each thread in it runs in its own plain folder,
 * carried in the thread's worktreePath like any thread that runs outside its
 * project root, so the provider, terminal, and file tree all use it.
 *
 * Offered only when the data dir sits outside any Git work tree: inside a
 * checkout (a dev worktree's .t3, a dotfiles home) the folders would inherit
 * that repository's status and checkpoints.
 *
 * @module ScratchProject
 */
import {
  CommandId,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ProjectProvisionError,
  type ProjectIconOverride,
  type ThreadId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import * as ProjectService from "./ProjectService.ts";

// A dashed chat bubble in neutral gray marks Scratch.
const SCRATCH_PROJECT_ICON: ProjectIconOverride = {
  kind: "lucide",
  name: "message-square-dashed",
  color: "gray",
};

/**
 * `<date>-<first words>-<id part>`. Only [a-z0-9] reaches the name, so it stays
 * one path segment inside the scratch root, and the words are capped so
 * pasted data cannot outgrow a file name.
 */
export function scratchThreadFolderName(input: {
  readonly date: string;
  readonly text: string;
  readonly idPart: string;
}): string {
  const words = input.text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
  return [input.date, words, input.idPart].filter(Boolean).join("-");
}

const provisionError = (message: string) => (cause: unknown) =>
  new ProjectProvisionError({ message, cause });

/**
 * Builds the Scratch helpers for one connection. The work-tree probe runs
 * once and is cached; detection failures and defects fail closed and hide
 * Scratch, while an interrupt invalidates the cache so the next caller probes
 * again.
 */
export const make = Effect.fn("ScratchProject.make")(function* (baseDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;

  const [cachedWorkspaceRoot, invalidateWorkspaceRoot] = yield* Effect.cachedInvalidateWithTTL(
    git.isRepository(baseDir).pipe(
      Effect.map((isRepository) => (isRepository ? undefined : path.resolve(baseDir, "scratch"))),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(undefined),
      ),
    ),
    Duration.infinity,
  );
  /** The Scratch folder, or undefined when this environment offers none. */
  const workspaceRoot: Effect.Effect<string | undefined> = cachedWorkspaceRoot.pipe(
    Effect.onInterrupt(() => invalidateWorkspaceRoot),
  );

  const makeRoot = (root: string) =>
    fileSystem
      .makeDirectory(root, { recursive: true })
      .pipe(
        Effect.mapError(
          provisionError("Failed to create the folder for threads without a project."),
        ),
      );

  const findProjectId = (root: string) =>
    projects
      .getByWorkspaceRoot(root)
      .pipe(
        Effect.map(Option.map((project) => project.id)),
        Effect.mapError(
          provisionError("Failed to look up the home for threads without a project."),
        ),
      );

  /**
   * Finds or creates the Scratch project. Two clients racing the create both
   * reach the project service; the loser's duplicate-root rejection resolves
   * to the project the winner made. The folder is (re)made on every call so a
   * deleted Scratch still runs.
   */
  const ensureProject = Effect.gen(function* () {
    const root = yield* workspaceRoot;
    if (root === undefined) {
      return yield* new ProjectProvisionError({
        message: "Threads without a project are not available on this environment.",
      });
    }
    yield* makeRoot(root);
    const existing = yield* findProjectId(root);
    if (Option.isSome(existing)) return { projectId: existing.value };

    const uuid = yield* randomUuidV4;
    const projectId = ProjectId.make(uuid);
    return yield* Effect.gen(function* () {
      yield* projects.create({
        commandId: CommandId.make(`server:scratch-project-create:${uuid}`),
        projectId,
        title: "No project",
        workspaceRoot: root,
      });
      // Set once at create, so a user's own icon choice is never overwritten.
      yield* projects.update({
        commandId: CommandId.make(`server:scratch-project-icon:${uuid}`),
        projectId,
        projectIcon: SCRATCH_PROJECT_ICON,
      });
      return { projectId };
    }).pipe(
      Effect.catch((error) =>
        findProjectId(root).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  provisionError("Failed to create the home for threads without a project.")(error),
                ),
              onSome: (racedProjectId) => Effect.succeed({ projectId: racedProjectId }),
            }),
          ),
        ),
      ),
    );
  });

  /**
   * Claims a fresh folder for a new thread in the Scratch project, named from
   * the server's date, the thread's first words, and its id. Resolves to null
   * when the project is not Scratch (or Scratch is not offered). Each leaf is
   * created without `recursive`, so the create itself claims it and a folder
   * is never shared: a taken short name falls back to the full id, and a taken
   * full id (ids that normalize alike, a retried launch) to the full id plus a
   * random suffix. A thread whose id the server has yet to allocate gets a
   * random one.
   */
  const threadFolder = (input: {
    readonly projectId: ProjectId;
    readonly threadId?: ThreadId | undefined;
    readonly text: string;
  }): Effect.Effect<string | null, ProjectProvisionError> =>
    Effect.gen(function* () {
      const root = yield* workspaceRoot;
      if (root === undefined) return null;
      const project = yield* projects
        .getById(input.projectId)
        .pipe(Effect.mapError(provisionError("Failed to look up the thread's project.")));
      if (
        Option.isNone(project) ||
        normalizeProjectPathForComparison(project.value.workspaceRoot) !==
          normalizeProjectPathForComparison(root)
      ) {
        return null;
      }
      const id = (input.threadId ?? (yield* randomUuidV4)).toLowerCase().replace(/[^a-z0-9]/g, "");
      const date = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
      const folderFor = (idPart: string) =>
        path.join(root, scratchThreadFolderName({ date, text: input.text, idPart }));
      yield* makeRoot(root);
      const claim = (folder: string) =>
        fileSystem.makeDirectory(folder).pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) => error.reason._tag === "AlreadyExists",
            () => Effect.succeed(false),
          ),
          Effect.mapError(provisionError("Failed to create the thread's folder.")),
        );
      const shortFolder = folderFor(id.slice(0, 8));
      if (yield* claim(shortFolder)) return shortFolder;
      const fullFolder = folderFor(id);
      if (yield* claim(fullFolder)) return fullFolder;
      while (true) {
        const folder = `${fullFolder}-${(yield* randomUuidV4).slice(0, 8)}`;
        if (yield* claim(folder)) return folder;
      }
    });

  /**
   * The workspace a thread launch should use. A new Scratch thread that names
   * no folder gets its own; a plain folder cannot host a worktree, so that
   * strategy lands there too. Relaunches of an existing thread, and launches
   * into any other project, pass through unchanged.
   */
  const launchWorkspaceStrategy = (input: {
    readonly projectId: ProjectId;
    readonly threadId?: ThreadId | undefined;
    readonly reuseExistingThread?: boolean | undefined;
    readonly workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
    readonly text: string;
  }): Effect.Effect<OrchestrationV2ThreadLaunchWorkspaceStrategy, ProjectProvisionError> =>
    input.workspaceStrategy.type === "existing_worktree" || input.reuseExistingThread === true
      ? Effect.succeed(input.workspaceStrategy)
      : threadFolder(input).pipe(
          Effect.map((worktreePath) =>
            worktreePath === null
              ? input.workspaceStrategy
              : { type: "existing_worktree" as const, worktreePath },
          ),
        );

  return { workspaceRoot, ensureProject, threadFolder, launchWorkspaceStrategy };
});

export type ScratchProject = Effect.Success<ReturnType<typeof make>>;
