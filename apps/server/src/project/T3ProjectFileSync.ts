/**
 * T3ProjectFileSync - keeps every project's actions and its checked-in
 * `t3.json` in sync, in both directions:
 *
 * - When actions change in the app (DB side), they are written to `t3.json`
 *   at the workspace root with the published `$schema` URL, so the file is
 *   always the durable, shareable source of the project's actions.
 * - When `t3.json` is edited on disk, the changes are decoded and applied to
 *   the project's actions, so edits show up in the app without a restart.
 *
 * The reconciler polls on a short interval and tracks the last-synced
 * normalized script list per project. Whichever side diverged from that
 * baseline wins the round; when both diverged, the file wins (it is the
 * checked-in truth a user just edited). On first sight of a project with an
 * existing file, the file also wins. Writes are skipped when the file
 * already encodes the same scripts, so hand formatting/comments survive
 * until the next in-app edit actually changes an action.
 *
 * @module T3ProjectFileSync
 */
import {
  CommandId,
  MAX_SCRIPT_ID_LENGTH,
  T3_PROJECT_FILE_NAME,
  T3_PROJECT_FILE_SCHEMA_URL,
  type Project,
  type ProjectScript,
  type T3ProjectFile,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ProjectService from "./ProjectService.ts";

const SYNC_INTERVAL = Duration.millis(1500);

const decodeT3ProjectFileJson = Schema.decodeEffect(T3ProjectFileFromJson);

/**
 * Identity of a script for cross-side comparison. Ids exist only on the DB
 * side, so normalization drops them and fills every optional flag.
 */
interface NormalizedScript {
  readonly name: string;
  readonly command: string;
  readonly icon: ProjectScript["icon"];
  readonly runOnWorktreeCreate: boolean;
  readonly runOnWorktreeDelete: boolean;
  readonly previewUrl: string | null;
  readonly autoOpenPreview: boolean;
  readonly singleRun: boolean;
}

function normalizeScripts(
  scripts: ReadonlyArray<ProjectScript | (T3ProjectFileScript & { readonly id?: string })>,
): string {
  const normalized: NormalizedScript[] = scripts.map((script) => ({
    name: script.name,
    command: script.command,
    icon: script.icon ?? "play",
    runOnWorktreeCreate: script.runOnWorktreeCreate ?? false,
    runOnWorktreeDelete: script.runOnWorktreeDelete ?? false,
    previewUrl: script.previewUrl ?? null,
    autoOpenPreview: script.autoOpenPreview ?? false,
    singleRun: script.singleRun ?? false,
  }));
  return JSON.stringify(normalized);
}

function slugScriptId(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = cleaned.length === 0 ? "script" : cleaned.slice(0, MAX_SCRIPT_ID_LENGTH);
  return base.replace(/-+$/g, "") || "script";
}

/**
 * Map file scripts to full ProjectScripts, reusing the existing action's id
 * when a script with the same name already exists (so keybindings bound to
 * `script.<id>.run` keep working across file edits).
 */
function scriptsFromFile(
  fileScripts: ReadonlyArray<T3ProjectFileScript>,
  existing: ReadonlyArray<ProjectScript>,
): ProjectScript[] {
  const byName = new Map(existing.map((script) => [script.name.toLowerCase(), script.id]));
  const taken = new Set<string>();
  return fileScripts.map((fileScript) => {
    let id = byName.get(fileScript.name.toLowerCase()) ?? slugScriptId(fileScript.name);
    if (taken.has(id)) {
      let suffix = 2;
      while (taken.has(`${id}-${suffix}`)) suffix += 1;
      id = `${id}-${suffix}`;
    }
    taken.add(id);
    return {
      id,
      name: fileScript.name,
      command: fileScript.command,
      icon: fileScript.icon ?? "play",
      runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
      ...(fileScript.runOnWorktreeDelete === true ? { runOnWorktreeDelete: true } : {}),
      ...(fileScript.previewUrl === undefined ? {} : { previewUrl: fileScript.previewUrl }),
      ...(fileScript.autoOpenPreview === undefined
        ? {}
        : { autoOpenPreview: fileScript.autoOpenPreview }),
      ...(fileScript.singleRun === undefined ? {} : { singleRun: fileScript.singleRun }),
    };
  });
}

function fileScriptFromProjectScript(script: ProjectScript): T3ProjectFileScript {
  return {
    name: script.name,
    command: script.command,
    icon: script.icon,
    ...(script.runOnWorktreeCreate ? { runOnWorktreeCreate: true } : {}),
    ...(script.runOnWorktreeDelete === true ? { runOnWorktreeDelete: true } : {}),
    ...(script.previewUrl === undefined ? {} : { previewUrl: script.previewUrl }),
    ...(script.autoOpenPreview === undefined ? {} : { autoOpenPreview: script.autoOpenPreview }),
    ...(script.singleRun === undefined ? {} : { singleRun: script.singleRun }),
  };
}

function renderProjectFile(
  existing: T3ProjectFile | null,
  scripts: ReadonlyArray<ProjectScript>,
): string {
  const document = {
    $schema: T3_PROJECT_FILE_SCHEMA_URL,
    ...(existing?.iconPath === undefined ? {} : { iconPath: existing.iconPath }),
    scripts: scripts.map(fileScriptFromProjectScript),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

const syncLoop = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cryptoService = yield* Crypto.Crypto;
  // projectId -> normalized scripts at the end of the last successful sync.
  const lastSynced = new Map<string, string>();

  const readProjectFile = Effect.fn("T3ProjectFileSync.readProjectFile")(function* (
    filePath: string,
  ) {
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.map(Option.some),
      Effect.catch(() => Effect.succeed(Option.none<string>())),
    );
    if (Option.isNone(raw)) {
      return null;
    }
    return yield* decodeT3ProjectFileJson(raw.value).pipe(
      Effect.catch((error) =>
        // An invalid file (mid-edit, syntax error) is skipped this round
        // rather than clobbered or imported.
        Effect.logDebug("Skipping unparseable t3.json during sync.", {
          filePath,
          error: String(error),
        }).pipe(Effect.as(null)),
      ),
    );
  });

  const writeProjectFile = Effect.fn("T3ProjectFileSync.writeProjectFile")(function* (
    project: Project,
    filePath: string,
    existing: T3ProjectFile | null,
  ) {
    yield* fileSystem.writeFileString(filePath, renderProjectFile(existing, project.scripts));
    yield* Effect.logInfo("Saved project actions to t3.json.", {
      projectId: project.id,
      filePath,
    });
  });

  const applyFileScripts = Effect.fn("T3ProjectFileSync.applyFileScripts")(function* (
    project: Project,
    scripts: ReadonlyArray<ProjectScript>,
  ) {
    yield* projects.update({
      commandId: CommandId.make(yield* cryptoService.randomUUIDv4),
      projectId: project.id,
      scripts,
    });
    yield* Effect.logInfo("Applied t3.json edits to project actions.", {
      projectId: project.id,
      scriptCount: scripts.length,
    });
  });

  const syncProject = Effect.fn("T3ProjectFileSync.syncProject")(function* (project: Project) {
    const filePath = path.join(project.workspaceRoot, T3_PROJECT_FILE_NAME);
    const file = yield* readProjectFile(filePath);
    const dbNorm = normalizeScripts(project.scripts);
    const fileNorm = file === null ? null : normalizeScripts(file.scripts ?? []);
    const baseline = lastSynced.get(project.id);

    if (baseline === undefined) {
      // First sight of this project: an existing file is the checked-in
      // truth; otherwise seed the file from the current actions.
      if (fileNorm !== null && fileNorm !== dbNorm) {
        yield* applyFileScripts(project, scriptsFromFile(file?.scripts ?? [], project.scripts));
        lastSynced.set(project.id, fileNorm);
      } else {
        if (fileNorm === null && project.scripts.length > 0) {
          yield* writeProjectFile(project, filePath, file);
        }
        lastSynced.set(project.id, dbNorm);
      }
      return;
    }

    const fileChanged = fileNorm !== null && fileNorm !== baseline;
    const dbChanged = dbNorm !== baseline;
    if (fileChanged) {
      // The file wins, including over a concurrent in-app edit: the user
      // touched the checked-in source directly.
      if (fileNorm !== dbNorm) {
        yield* applyFileScripts(project, scriptsFromFile(file?.scripts ?? [], project.scripts));
      }
      lastSynced.set(project.id, fileNorm);
      return;
    }
    if (dbChanged || (fileNorm === null && project.scripts.length > 0)) {
      yield* writeProjectFile(project, filePath, file);
      lastSynced.set(project.id, dbNorm);
    }
  });

  const syncOnce = Effect.gen(function* () {
    const snapshot = yield* projects.snapshot;
    for (const project of snapshot.projects) {
      yield* syncProject(project).pipe(Effect.ignoreCause({ log: true }));
    }
  });

  yield* syncOnce.pipe(
    Effect.ignoreCause({ log: true }),
    Effect.repeat(Schedule.spaced(SYNC_INTERVAL)),
  );
});

/** Background reconciler; merge into the server layer graph to activate. */
export const layer = Layer.effectDiscard(Effect.forkScoped(syncLoop));
