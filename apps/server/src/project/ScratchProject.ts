/**
 * Threads without a project live in the environment's Scratch project: a
 * plain folder under the data dir that clients show as "No project". The
 * server creates it on first request, and each Scratch thread works in its
 * own subfolder, carried in the thread's worktreePath like any thread that
 * runs outside its project root, so the provider, terminal, and file tree all
 * use it.
 */
import type { CommandId, ProjectIconOverride, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectService from "./ProjectService.ts";

export const SCRATCH_PROJECT_TITLE = "No project";

// A dashed chat bubble in neutral gray marks Scratch.
export const SCRATCH_PROJECT_ICON: ProjectIconOverride = {
  kind: "lucide",
  name: "message-square-dashed",
  color: "gray",
};

/**
 * Names a Scratch thread's folder from its date, first words, and an id part.
 * Only [a-z0-9] reaches the name, so it stays one path segment inside the
 * Scratch root, and the words are capped so pasted data cannot outgrow a
 * file name.
 */
export function scratchThreadFolderName(input: {
  readonly createdAt: string;
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
  return [input.createdAt.slice(0, 10), words, input.idPart].filter(Boolean).join("-");
}

/**
 * Creates a Scratch thread's own folder under the Scratch root and returns its
 * path. Each leaf is created without `recursive`, so the create itself claims
 * it: a taken short name falls back to the full id, which only the same thread
 * can already hold.
 */
export const claimScratchThreadFolder = Effect.fn("ScratchProject.claimThreadFolder")(
  function* (input: {
    readonly scratchRoot: string;
    readonly threadId: ThreadId;
    readonly createdAt: string;
    readonly text: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const id = input.threadId.toLowerCase().replace(/[^a-z0-9]/g, "");
    const folderFor = (idPart: string) =>
      path.join(
        input.scratchRoot,
        scratchThreadFolderName({ createdAt: input.createdAt, text: input.text, idPart }),
      );
    yield* fileSystem.makeDirectory(input.scratchRoot, { recursive: true });
    const claim = (folder: string) =>
      fileSystem.makeDirectory(folder).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
      );
    const shortFolder = folderFor(id.slice(0, 8));
    if (yield* claim(shortFolder)) return shortFolder;
    const fullFolder = folderFor(id);
    yield* claim(fullFolder);
    return fullFolder;
  },
);

/**
 * Finds or creates the Scratch project rooted at `workspaceRoot` and returns
 * its id. The folder is (re)made on every call so a deleted Scratch still
 * runs. Two clients racing the create both reach ProjectService; the loser's
 * conflict resolves to the project the winner made.
 */
export const ensureScratchProject = Effect.fn("ScratchProject.ensure")(function* (input: {
  readonly workspaceRoot: string;
  readonly projectId: ProjectId;
  readonly commandId: (step: "create" | "icon") => CommandId;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const projects = yield* ProjectService.ProjectService;
  yield* fileSystem.makeDirectory(input.workspaceRoot, { recursive: true });
  const findScratchProjectId = projects
    .getByWorkspaceRoot(input.workspaceRoot)
    .pipe(Effect.map(Option.map((project) => project.id)));
  const existing = yield* findScratchProjectId;
  if (Option.isSome(existing)) return existing.value;
  return yield* Effect.gen(function* () {
    yield* projects.create({
      commandId: input.commandId("create"),
      projectId: input.projectId,
      title: SCRATCH_PROJECT_TITLE,
      workspaceRoot: input.workspaceRoot,
    });
    // Set once at create, so a user's own icon choice is never overwritten.
    yield* projects.update({
      commandId: input.commandId("icon"),
      projectId: input.projectId,
      projectIcon: SCRATCH_PROJECT_ICON,
    });
    return input.projectId;
  }).pipe(
    Effect.catch((error) =>
      findScratchProjectId.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(error),
            onSome: (racedProjectId) => Effect.succeed(racedProjectId),
          }),
        ),
      ),
    ),
  );
});
