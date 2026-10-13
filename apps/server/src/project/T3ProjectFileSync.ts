/**
 * T3ProjectFileSync - keeps a project's actions and the `scripts` in its
 * checked-in `t3.json` the same, in both directions.
 *
 * - A `t3.json` that declares `scripts` gives the project its own action list
 *   (the project override of `defaultProjectScripts`), when the server first
 *   sees the project and whenever the file changes on disk. The file wins a
 *   conflict: it is the checked-in source a teammate or agent just edited.
 * - An in-app edit of a project's own actions rewrites `scripts` in the file,
 *   creating it if needed. Every other field, every unknown field, and the
 *   unknown fields of each script survive the rewrite.
 * - Once per T3 home, projects with their own actions and no `t3.json` get
 *   one. Deleting the file afterwards is respected until the next edit.
 *
 * Files are polled by mtime, so a project costs one `stat` per round.
 *
 * @module T3ProjectFileSync
 */
import {
  MAX_SCRIPT_ID_LENGTH,
  T3_PROJECT_FILE_NAME,
  T3_PROJECT_FILE_SCHEMA_URL,
  T3ProjectFile,
  type Project,
  type ProjectId,
  type ProjectScript,
  type ServerSettings,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";

const POLL_INTERVAL = "2 seconds";
const BACKFILL_MARKER = "t3-json-backfill.done";

const decodeRawFile = Schema.decodeUnknownEffect(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeFile = Schema.decodeUnknownEffect(T3ProjectFile);

type RawObject = Record<string, unknown>;

/** Script fields the app owns; anything else on a script in the file is carried through. */
const OWNED_SCRIPT_KEYS = new Set<string>([
  "name",
  "command",
  "icon",
  "runOnWorktreeCreate",
  "runOnSettle",
  "runOnWorktreeDelete",
  "singleRun",
  "async",
  "previewUrl",
  "autoOpenPreview",
]);

/** A comparable form of a script list; ids exist only in the app, so they are left out. */
function normalizeScripts(scripts: ReadonlyArray<T3ProjectFileScript | ProjectScript>): string {
  return JSON.stringify(
    scripts.map((script) => [
      script.name,
      script.command,
      script.icon ?? "play",
      script.runOnWorktreeCreate ?? false,
      script.runOnSettle ?? false,
      script.runOnWorktreeDelete ?? false,
      script.singleRun ?? false,
      script.async ?? null,
      script.previewUrl ?? null,
      script.autoOpenPreview ?? false,
    ]),
  );
}

function slugScriptId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SCRIPT_ID_LENGTH)
    .replace(/-+$/g, "");
  return slug.length === 0 ? "script" : slug;
}

/**
 * The project's actions for a file's scripts. An action whose name matches
 * keeps its id, so a shortcut bound to `script.<id>.run` keeps working.
 */
function scriptsFromFile(
  fileScripts: ReadonlyArray<T3ProjectFileScript>,
  current: ReadonlyArray<ProjectScript>,
): ProjectScript[] {
  const idsByName = new Map(current.map((script) => [script.name.toLowerCase(), script.id]));
  const taken = new Set<string>();
  return fileScripts.map((fileScript) => {
    const base = idsByName.get(fileScript.name.toLowerCase()) ?? slugScriptId(fileScript.name);
    let id = base;
    for (let suffix = 2; taken.has(id); suffix += 1) {
      id = `${base.slice(0, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1)}-${suffix}`;
    }
    taken.add(id);
    return {
      id,
      name: fileScript.name,
      command: fileScript.command,
      icon: fileScript.icon ?? "play",
      runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
      ...(fileScript.runOnSettle === undefined ? {} : { runOnSettle: fileScript.runOnSettle }),
      ...(fileScript.runOnWorktreeDelete === undefined
        ? {}
        : { runOnWorktreeDelete: fileScript.runOnWorktreeDelete }),
      ...(fileScript.singleRun === undefined ? {} : { singleRun: fileScript.singleRun }),
      ...(fileScript.async === undefined ? {} : { async: fileScript.async }),
      ...(fileScript.previewUrl === undefined ? {} : { previewUrl: fileScript.previewUrl }),
      ...(fileScript.autoOpenPreview === undefined
        ? {}
        : { autoOpenPreview: fileScript.autoOpenPreview }),
    };
  });
}

const isRawObject = (value: unknown): value is RawObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The `t3.json` text for a project's actions. `existing` is the file as raw
 * JSON: its other fields stay where they are, and a script keeps the fields
 * the app does not own from the file script with the same name (or command).
 */
export function renderProjectFile(
  existing: RawObject | null,
  scripts: ReadonlyArray<ProjectScript>,
): string {
  const existingScripts = Array.isArray(existing?.scripts)
    ? existing.scripts.filter(isRawObject)
    : [];
  const fileScripts = scripts.map((script) => {
    const previous =
      existingScripts.find(
        (raw) =>
          typeof raw.name === "string" && raw.name.toLowerCase() === script.name.toLowerCase(),
      ) ?? existingScripts.find((raw) => raw.command === script.command);
    const unowned = Object.fromEntries(
      Object.entries(previous ?? {}).filter(([key]) => !OWNED_SCRIPT_KEYS.has(key)),
    );
    return {
      name: script.name,
      command: script.command,
      icon: script.icon,
      ...(script.runOnWorktreeCreate ? { runOnWorktreeCreate: true } : {}),
      ...(script.runOnSettle ? { runOnSettle: true } : {}),
      ...(script.runOnWorktreeDelete ? { runOnWorktreeDelete: true } : {}),
      ...(script.singleRun ? { singleRun: true } : {}),
      ...(script.async === undefined ? {} : { async: script.async }),
      ...(script.previewUrl === undefined ? {} : { previewUrl: script.previewUrl }),
      ...(script.autoOpenPreview === undefined ? {} : { autoOpenPreview: script.autoOpenPreview }),
      ...unowned,
    };
  });
  const document = existing
    ? { ...existing, scripts: fileScripts }
    : { $schema: T3_PROJECT_FILE_SCHEMA_URL, scripts: fileScripts };
  return `${JSON.stringify(document, null, 2)}\n`;
}

type ProjectFileState =
  | { readonly status: "missing" }
  | { readonly status: "invalid" }
  | {
      readonly status: "valid";
      readonly raw: RawObject;
      readonly scripts: ReadonlyArray<T3ProjectFileScript> | undefined;
    };

interface Baseline {
  /** Normalized own actions, or null while the project follows environment defaults. */
  readonly own: string | null;
  /** Normalized file scripts, or null when the file declares none. */
  readonly file: string | null;
  readonly fileStamp: string | null;
}

export class T3ProjectFileSync extends Context.Service<
  T3ProjectFileSync,
  {
    /**
     * Reconcile every project once; the first call also runs the one-time
     * backfill. Never fails: a broken project is logged and skipped.
     */
    readonly syncNow: Effect.Effect<void>;
    /** Reconcile now, then on settings changes and on a short poll. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/project/T3ProjectFileSync") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const settingsService = yield* ServerSettingsService.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baselines = new Map<ProjectId, Baseline>();

  const fileStamp = (filePath: string) =>
    fileSystem.stat(filePath).pipe(
      Effect.map((info) => `${Option.getOrNull(info.mtime)?.getTime() ?? 0}:${info.size}`),
      Effect.orElseSucceed(() => null),
    );

  const readProjectFile = Effect.fn("T3ProjectFileSync.readProjectFile")(function* (
    filePath: string,
  ) {
    const contents = yield* fileSystem
      .readFileString(filePath)
      .pipe(Effect.orElseSucceed(() => null));
    if (contents === null) return { status: "missing" } as const satisfies ProjectFileState;
    const raw = yield* decodeRawFile(contents).pipe(Effect.orElseSucceed(() => null));
    // A file mid-edit or with a schema error is skipped, never clobbered.
    const file =
      raw === null ? null : yield* decodeFile(raw).pipe(Effect.orElseSucceed(() => null));
    if (raw === null || file === null) return { status: "invalid" } as const;
    return { status: "valid", raw, scripts: file.scripts } as const;
  });

  const ownScripts = (settings: ServerSettings, projectId: ProjectId) =>
    settings.projectSettingsOverrides[projectId]?.defaultProjectScripts;

  const setOwnScripts = (projectId: ProjectId, scripts: ReadonlyArray<ProjectScript>) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      yield* settingsService.updateSettings({
        projectSettingsOverrides: {
          [projectId]: {
            ...settings.projectSettingsOverrides[projectId],
            defaultProjectScripts: scripts,
          },
        },
      });
    });

  const syncProject = Effect.fn("T3ProjectFileSync.syncProject")(function* (
    project: Project,
    settings: ServerSettings,
  ) {
    const filePath = path.join(project.workspaceRoot, T3_PROJECT_FILE_NAME);
    const own = ownScripts(settings, project.id);
    const ownNorm = own === undefined ? null : normalizeScripts(own);
    const stamp = yield* fileStamp(filePath);
    const baseline = baselines.get(project.id);
    if (baseline && baseline.own === ownNorm && baseline.fileStamp === stamp) return;

    const file = yield* readProjectFile(filePath);
    if (file.status === "invalid") return;
    const fileScripts = file.status === "valid" ? file.scripts : undefined;
    const fileNorm = fileScripts === undefined ? null : normalizeScripts(fileScripts);
    const fileChanged = baseline === undefined || fileNorm !== baseline.file;

    // A file that declares scripts is the project's list: adopt it when it is
    // new to this server, when it changed, or when the project has no list of
    // its own (a reset in the app follows the file again).
    if (fileScripts !== undefined && fileNorm !== ownNorm && (fileChanged || own === undefined)) {
      yield* setOwnScripts(
        project.id,
        scriptsFromFile(fileScripts, resolveProjectScripts(settings, project)),
      );
      yield* Effect.logInfo("Applied t3.json scripts to project actions", {
        projectId: project.id,
      });
      baselines.set(project.id, { own: fileNorm, file: fileNorm, fileStamp: stamp });
      return;
    }
    // An in-app edit of the project's own list is written back.
    if (own !== undefined && baseline !== undefined && ownNorm !== baseline.own) {
      if (ownNorm !== fileNorm) {
        yield* fileSystem.writeFileString(
          filePath,
          renderProjectFile(file.status === "valid" ? file.raw : null, own),
        );
        yield* Effect.logInfo("Saved project actions to t3.json", { projectId: project.id });
      }
      baselines.set(project.id, {
        own: ownNorm,
        file: ownNorm,
        fileStamp: yield* fileStamp(filePath),
      });
      return;
    }
    baselines.set(project.id, { own: ownNorm, file: fileNorm, fileStamp: stamp });
  });

  const activeProjects = projects.snapshot.pipe(
    Effect.map((snapshot) => snapshot.projects.filter((project) => project.deletedAt === null)),
  );

  /** Seeds `t3.json` for projects whose own actions predate the sync. Runs once per T3 home. */
  const backfill = Effect.gen(function* () {
    const marker = path.join(config.stateDir, BACKFILL_MARKER);
    if (yield* fileSystem.exists(marker)) return;
    const settings = yield* settingsService.getSettings;
    for (const project of yield* activeProjects) {
      const own = ownScripts(settings, project.id);
      const filePath = path.join(project.workspaceRoot, T3_PROJECT_FILE_NAME);
      // An unreadable workspace counts as having a file: skip rather than guess.
      if (
        own === undefined ||
        own.length === 0 ||
        (yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => true)))
      ) {
        continue;
      }
      yield* fileSystem.writeFileString(filePath, renderProjectFile(null, own)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to seed t3.json for a project", {
            projectId: project.id,
            cause,
          }),
        ),
      );
    }
    yield* fileSystem.makeDirectory(config.stateDir, { recursive: true });
    yield* fileSystem.writeFileString(marker, "");
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("t3.json backfill failed", { cause })));

  let backfilled = false;
  const syncNow: T3ProjectFileSync["Service"]["syncNow"] = Effect.gen(function* () {
    if (!backfilled) {
      backfilled = true;
      yield* backfill;
    }
    const settings = yield* settingsService.getSettings;
    for (const project of yield* activeProjects) {
      yield* syncProject(project, settings).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to sync t3.json for a project", {
            projectId: project.id,
            cause,
          }),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("t3.json sync round failed", { cause })),
    Effect.withSpan("T3ProjectFileSync.syncNow"),
  );

  const start: T3ProjectFileSync["Service"]["start"] = Effect.fn("T3ProjectFileSync.start")(
    function* () {
      const settingsChanges = yield* settingsService.subscribeChanges;
      yield* forkParked(
        Effect.gen(function* () {
          yield* syncNow;
          yield* Stream.merge(
            Stream.fromSchedule(Schedule.spaced(POLL_INTERVAL)),
            settingsChanges,
          ).pipe(Stream.runForEach(() => syncNow));
        }),
      );
    },
  );

  return T3ProjectFileSync.of({ syncNow, start });
});
