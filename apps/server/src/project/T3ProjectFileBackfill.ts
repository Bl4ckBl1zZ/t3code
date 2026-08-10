/**
 * T3ProjectFileBackfill - one-time write of `t3.json` for projects whose
 * actions only ever existed in the database.
 *
 * `t3.json` is the durable, shareable source of a project's actions, but
 * projects created before it existed carry their actions only in the
 * projection. Writing the file once brings them onto the same footing as a
 * project that was always file-backed.
 *
 * Deliberately narrow, and never runs twice:
 *
 * - Only projects with at least one action and no readable `t3.json` are
 *   touched; an existing file is never read, rewritten, or reformatted.
 * - The marker is persisted in server settings, so deleting a project's
 *   `t3.json` afterwards is a decision the next boot respects. That is the
 *   whole reason the marker exists rather than inferring the work from a
 *   missing file — `T3ProjectFileSync` used to reseed on every round, which
 *   made deleting the file impossible.
 * - Per-project failures are isolated and logged: one unwritable workspace
 *   root must not stop the rest, and the next boot retries it only if the
 *   marker was never recorded.
 *
 * @module T3ProjectFileBackfill
 */
import {
  T3_PROJECT_FILE_NAME,
  type Project,
  type ProjectId,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveProjectFileSchemaUrl } from "./projectFileSchemaUrl.ts";
import * as ProjectService from "./ProjectService.ts";
import { renderProjectFile } from "./T3ProjectFileSync.ts";

/**
 * Whether this project needs its `t3.json` seeded.
 *
 * A project with no actions is skipped rather than given an empty `scripts`
 * array: an empty file says "this project declares no actions", which is a
 * claim the backfill has no business making on the user's behalf.
 */
export function needsProjectFileBackfill(project: Project, fileExists: boolean): boolean {
  return !fileExists && project.scripts.length > 0;
}

/**
 * The settings patch recording that the backfill ran, or `null` when it
 * already has. Mirrors the Hermes proactive-default migration: the caller
 * reads settings, runs the work, then persists the marker.
 */
export function projectFileBackfillPatch(settings: ServerSettings): ServerSettingsPatch | null {
  return settings.projectFileBackfillApplied ? null : { projectFileBackfillApplied: true };
}

/**
 * Write `t3.json` for every project that needs it, returning the ids actually
 * written so the caller can log what moved.
 *
 * Never fails: a project whose file cannot be probed is treated as already
 * having one, and a failed write is logged and skipped.
 */
export const writeMissingProjectFiles = Effect.fn("T3ProjectFileBackfill.writeMissingFiles")(
  function* () {
    const projects = yield* ProjectService.ProjectService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const schemaUrl = resolveProjectFileSchemaUrl();

    const snapshot = yield* projects.snapshot;
    const written: Array<ProjectId> = [];
    for (const project of snapshot.projects) {
      const filePath = path.join(project.workspaceRoot, T3_PROJECT_FILE_NAME);
      // An unreadable workspace root counts as "has a file": the backfill
      // would rather skip a project than write into a root it cannot inspect.
      const fileExists = yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => true));
      if (!needsProjectFileBackfill(project, fileExists)) continue;

      const wrote = yield* fileSystem
        .writeFileString(filePath, renderProjectFile(null, project.scripts, schemaUrl))
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to seed t3.json for an existing project.", {
              projectId: project.id,
              filePath,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
      if (wrote) written.push(project.id);
    }
    return written as ReadonlyArray<ProjectId>;
  },
);
