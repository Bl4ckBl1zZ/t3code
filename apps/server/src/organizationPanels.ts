import {
  OrganizationId,
  OrganizationPanelError,
  OrganizationPanelSlug,
  OrganizationPanelTurnId,
  OrganizationPanelVersion as OrganizationPanelVersionSchema,
  OrganizationPanelVersionId,
  type OrganizationPanelEvent,
  type OrganizationPanelGetResult,
  type OrganizationPanelHistoryListResult,
  type OrganizationPanelOrganization,
  type OrganizationPanelRollbackResult,
  type OrganizationPanelSnapshot,
  type OrganizationPanelTurnStartResult,
  type OrganizationPanelVersion,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import type { ServerConfigShape } from "./config.ts";

export interface OrganizationPanelPath {
  readonly organizationId: OrganizationId;
  readonly panelSlug: OrganizationPanelSlug;
  readonly folderAbsolutePath: string;
  readonly panelFileAbsolutePath: string;
  readonly panelImportPath: string;
  readonly panelFileRelativePath: string;
}

const PANEL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PANEL_SOURCE_ROOT = "apps/web/src/organization-panels";
const PANEL_FILE_NAME = "Panel.tsx";
const PANEL_HISTORY_FILE_NAME = "organization-panel-versions.ndjson";

const ALLOWED_PANEL_IMPORTS = ["react", "../_shared/types", "../_shared/imports"] as const;
const DISALLOWED_IMPORT_FRAGMENTS = [
  "apps/server",
  "@t3tools/server",
  "node:",
  "child_process",
  "fs",
  "path",
  "crypto",
  "process",
] as const;

const ORGANIZATIONS: ReadonlyArray<OrganizationPanelOrganization> = [
  {
    id: OrganizationId.make("acme"),
    slug: "acme",
    name: "Acme",
    panelSlug: OrganizationPanelSlug.make("acme"),
  },
  {
    id: OrganizationId.make("ping"),
    slug: "ping",
    name: "Ping",
    panelSlug: OrganizationPanelSlug.make("ping"),
  },
];

const StoredOrganizationPanelVersionSchema = Schema.Struct({
  ...OrganizationPanelVersionSchema.fields,
  beforeContents: Schema.String,
  afterContents: Schema.String,
});
type StoredOrganizationPanelVersion = typeof StoredOrganizationPanelVersionSchema.Type;
const StoredOrganizationPanelVersionJson = Schema.fromJsonString(
  StoredOrganizationPanelVersionSchema,
);
const decodeStoredOrganizationPanelVersion = Schema.decodeUnknownEffect(
  StoredOrganizationPanelVersionJson,
);
const encodeStoredOrganizationPanelVersion = Schema.encodeEffect(
  StoredOrganizationPanelVersionJson,
);

const eventSubscribers = new Set<(event: OrganizationPanelEvent) => void>();
const activeTurnsByOrganization = new Map<OrganizationId, OrganizationPanelTurnId>();
const organizationLocks = new Map<OrganizationId, Semaphore.Semaphore>();

export function isValidOrganizationPanelSlug(slug: string): boolean {
  return PANEL_SLUG_PATTERN.test(slug);
}

export function subscribeOrganizationPanelEvents(
  listener: (event: OrganizationPanelEvent) => void,
): () => void {
  eventSubscribers.add(listener);
  return () => {
    eventSubscribers.delete(listener);
  };
}

export function validateOrganizationPanelSource(source: string): readonly string[] {
  const errors: string[] = [];
  const importSpecifiers = collectImportSpecifiers(source);

  for (const specifier of importSpecifiers) {
    if (!ALLOWED_PANEL_IMPORTS.includes(specifier as (typeof ALLOWED_PANEL_IMPORTS)[number])) {
      errors.push(`Import "${specifier}" is not allowed.`);
      continue;
    }

    if (DISALLOWED_IMPORT_FRAGMENTS.some((fragment) => specifier.includes(fragment))) {
      errors.push(`Import "${specifier}" references a server-only or unsafe module.`);
    }
  }

  if (/\bimport\s*\(/u.test(source)) {
    errors.push("Dynamic imports are not allowed in organization panels.");
  }

  if (/\bprocess\b|\bimport\.meta\.env\b|\bdocument\.cookie\b|\blocalStorage\b/u.test(source)) {
    errors.push("Generated panels cannot access process, env, cookies, or local storage.");
  }

  if (!/\bexport\s+default\b/u.test(source)) {
    errors.push("Panel.tsx must default-export a React component.");
  }

  return errors;
}

export const resolveOrganizationPanelPath = (input: {
  readonly repositoryRoot: string;
  readonly organizationId: OrganizationId;
  readonly panelSlug: OrganizationPanelSlug;
}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const panelSlug = String(input.panelSlug);

    if (!isValidOrganizationPanelSlug(panelSlug)) {
      return yield* panelError(
        "invalid-panel-slug",
        `Invalid organization panel slug "${panelSlug}".`,
      );
    }

    const panelsRoot = path.resolve(input.repositoryRoot, PANEL_SOURCE_ROOT);
    const folderAbsolutePath = path.resolve(panelsRoot, panelSlug);
    const panelFileAbsolutePath = path.resolve(folderAbsolutePath, PANEL_FILE_NAME);
    const expectedFolderPath = path.join(panelsRoot, panelSlug);
    const expectedPanelFilePath = path.join(expectedFolderPath, PANEL_FILE_NAME);

    if (
      folderAbsolutePath !== expectedFolderPath ||
      panelFileAbsolutePath !== expectedPanelFilePath
    ) {
      return yield* panelError(
        "path-outside-boundary",
        "Resolved panel path escaped its organization folder.",
      );
    }

    return {
      organizationId: input.organizationId,
      panelSlug: input.panelSlug,
      folderAbsolutePath,
      panelFileAbsolutePath,
      panelImportPath: `../organization-panels/${panelSlug}/Panel.tsx`,
      panelFileRelativePath: `${PANEL_SOURCE_ROOT}/${panelSlug}/${PANEL_FILE_NAME}`,
    } satisfies OrganizationPanelPath;
  });

export const getOrganizationPanel = (input: {
  readonly config: ServerConfigShape;
  readonly organizationId: OrganizationId;
  readonly now: string;
}): Effect.Effect<
  OrganizationPanelGetResult,
  OrganizationPanelError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const context = yield* loadPanelContext(input);
    const latestVersion = yield* latestVersionForOrganization(input.config, input.organizationId);
    return toSnapshot({
      context,
      now: input.now,
      latestVersion,
    });
  });

export const listOrganizationPanelHistory = (input: {
  readonly config: ServerConfigShape;
  readonly organizationId: OrganizationId;
  readonly limit?: number | undefined;
}): Effect.Effect<
  OrganizationPanelHistoryListResult,
  OrganizationPanelError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    yield* resolveOrganization(input.organizationId);
    const versions = yield* readStoredVersions(input.config);
    const limit = input.limit ?? 50;
    return {
      versions: versions
        .filter((version) => version.organizationId === input.organizationId)
        .slice(-limit)
        .toReversed()
        .map(toPublicVersion),
    };
  });

export const startOrganizationPanelTurn = (input: {
  readonly config: ServerConfigShape;
  readonly organizationId: OrganizationId;
  readonly prompt: string;
  readonly turnId: OrganizationPanelTurnId;
  readonly versionId: OrganizationPanelVersionId;
  readonly now: string;
}): Effect.Effect<
  OrganizationPanelTurnStartResult,
  OrganizationPanelError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const lock = yield* getOrganizationLock(input.organizationId);
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (activeTurnsByOrganization.has(input.organizationId)) {
          return yield* panelError(
            "active-turn-running",
            "An organization panel turn is already running.",
          );
        }

        activeTurnsByOrganization.set(input.organizationId, input.turnId);
        const runTurn = Effect.gen(function* () {
          const context = yield* loadPanelContext(input);
          const beforeContents = yield* readPanelFile(context.path);
          const afterContents = renderPanelSourceFromPrompt({
            organization: context.organization,
            prompt: input.prompt,
          });
          const validationErrors = validateOrganizationPanelSource(afterContents);

          publishPanelEvent({
            type: "turn.started",
            organizationId: input.organizationId,
            turnId: input.turnId,
            prompt: input.prompt,
          });
          publishPanelEvent({
            type: "turn.delta",
            organizationId: input.organizationId,
            turnId: input.turnId,
            message: "Generated a bounded Panel.tsx update.",
          });

          if (validationErrors.length > 0) {
            publishPanelEvent({
              type: "validation.result",
              organizationId: input.organizationId,
              turnId: input.turnId,
              status: "failed",
              errors: validationErrors,
            });
            publishPanelEvent({
              type: "turn.failed",
              organizationId: input.organizationId,
              turnId: input.turnId,
              reason: validationErrors.join(" "),
            });
            return yield* panelError(
              "validation-failed",
              "Generated panel failed validation.",
              validationErrors,
            );
          }

          const diff = createUnifiedDiff(
            context.path.panelFileRelativePath,
            beforeContents,
            afterContents,
          );
          yield* writePanelFile(context.path, afterContents);
          const version = yield* appendStoredVersion(input.config, {
            id: input.versionId,
            organizationId: input.organizationId,
            panelSlug: context.organization.panelSlug,
            turnId: input.turnId,
            prompt: input.prompt,
            filePath: context.path.panelFileRelativePath,
            beforeHash: hashContents(beforeContents),
            afterHash: hashContents(afterContents),
            diff,
            status: "applied",
            createdAt: input.now,
            beforeContents,
            afterContents,
          });

          publishPanelEvent({
            type: "file.patch",
            organizationId: input.organizationId,
            turnId: input.turnId,
            filePath: context.path.panelFileRelativePath,
            diff,
          });
          publishPanelEvent({
            type: "validation.result",
            organizationId: input.organizationId,
            turnId: input.turnId,
            status: "passed",
            errors: [],
          });
          publishPanelEvent({
            type: "compile.result",
            organizationId: input.organizationId,
            turnId: input.turnId,
            status: "passed",
            errors: [],
          });
          publishPanelEvent({
            type: "turn.completed",
            organizationId: input.organizationId,
            turnId: input.turnId,
            versionId: version.id,
          });

          const snapshot = toSnapshot({
            context: { ...context, contents: afterContents },
            now: input.now,
            latestVersion: version,
          });
          publishSnapshotEvent(snapshot);
          return { turnId: input.turnId, version, snapshot };
        });

        return yield* runTurn.pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (error.code !== "validation-failed") {
                publishPanelEvent({
                  type: "turn.failed",
                  organizationId: input.organizationId,
                  turnId: input.turnId,
                  reason: error.message,
                });
              }
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => activeTurnsByOrganization.delete(input.organizationId)),
          ),
        );
      }),
    );
  });

export function stopOrganizationPanelTurn(input: {
  readonly organizationId: OrganizationId;
  readonly turnId: OrganizationPanelTurnId;
}): Effect.Effect<{ readonly stopped: boolean }, OrganizationPanelError> {
  return Effect.sync(() => {
    const activeTurnId = activeTurnsByOrganization.get(input.organizationId);
    if (activeTurnId !== input.turnId) {
      return { stopped: false };
    }
    activeTurnsByOrganization.delete(input.organizationId);
    publishPanelEvent({
      type: "turn.failed",
      organizationId: input.organizationId,
      turnId: input.turnId,
      reason: "Panel turn stopped.",
    });
    return { stopped: true };
  });
}

export const rollbackOrganizationPanel = (input: {
  readonly config: ServerConfigShape;
  readonly organizationId: OrganizationId;
  readonly versionId: OrganizationPanelVersionId;
  readonly turnId: OrganizationPanelTurnId;
  readonly rollbackVersionId: OrganizationPanelVersionId;
  readonly now: string;
}): Effect.Effect<
  OrganizationPanelRollbackResult,
  OrganizationPanelError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    if (activeTurnsByOrganization.has(input.organizationId)) {
      return yield* panelError(
        "active-turn-running",
        "Cannot rollback while a panel turn is active.",
      );
    }

    const lock = yield* getOrganizationLock(input.organizationId);
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (activeTurnsByOrganization.has(input.organizationId)) {
          return yield* panelError(
            "active-turn-running",
            "Cannot rollback while a panel turn is active.",
          );
        }

        const context = yield* loadPanelContext(input);
        const versions = yield* readStoredVersions(input.config);
        const target = versions.find(
          (version) =>
            version.organizationId === input.organizationId && version.id === input.versionId,
        );

        if (!target) {
          return yield* panelError(
            "rollback-unavailable",
            "Selected organization panel version was not found.",
          );
        }

        const validationErrors = validateOrganizationPanelSource(target.beforeContents);
        if (validationErrors.length > 0) {
          return yield* panelError(
            "rollback-failed",
            "Previous organization panel source failed validation.",
            validationErrors,
          );
        }

        const beforeContents = yield* readPanelFile(context.path);
        const afterContents = target.beforeContents;
        const diff = createUnifiedDiff(
          context.path.panelFileRelativePath,
          beforeContents,
          afterContents,
        );
        yield* writePanelFile(context.path, afterContents);

        const version = yield* appendStoredVersion(input.config, {
          id: input.rollbackVersionId,
          organizationId: input.organizationId,
          panelSlug: context.organization.panelSlug,
          turnId: input.turnId,
          prompt: `Rollback ${target.id}`,
          filePath: context.path.panelFileRelativePath,
          beforeHash: hashContents(beforeContents),
          afterHash: hashContents(afterContents),
          diff,
          status: "rolled-back",
          createdAt: input.now,
          beforeContents,
          afterContents,
        });

        publishPanelEvent({
          type: "file.patch",
          organizationId: input.organizationId,
          turnId: input.turnId,
          filePath: context.path.panelFileRelativePath,
          diff,
        });
        publishPanelEvent({
          type: "validation.result",
          organizationId: input.organizationId,
          turnId: input.turnId,
          status: "passed",
          errors: [],
        });
        publishPanelEvent({
          type: "compile.result",
          organizationId: input.organizationId,
          turnId: input.turnId,
          status: "passed",
          errors: [],
        });
        publishPanelEvent({
          type: "turn.completed",
          organizationId: input.organizationId,
          turnId: input.turnId,
          versionId: version.id,
        });

        const snapshot = toSnapshot({
          context: { ...context, contents: afterContents },
          now: input.now,
          latestVersion: version,
        });
        publishSnapshotEvent(snapshot);
        return { version, snapshot };
      }),
    );
  });

const getOrganizationLock = (organizationId: OrganizationId) =>
  Effect.gen(function* () {
    const existing = organizationLocks.get(organizationId);
    if (existing) {
      return existing;
    }

    const lock = yield* Semaphore.make(1);
    const current = organizationLocks.get(organizationId);
    if (current) {
      return current;
    }
    organizationLocks.set(organizationId, lock);
    return lock;
  });

function collectImportSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  const fromPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+["']([^"']+)["']/gu;
  const sideEffectPattern = /\bimport\s+["']([^"']+)["']/gu;
  for (const match of source.matchAll(fromPattern)) {
    const specifier = match[1];
    if (specifier) {
      specifiers.push(specifier);
    }
  }
  for (const match of source.matchAll(sideEffectPattern)) {
    const specifier = match[1];
    if (specifier) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

function resolveOrganization(
  organizationId: OrganizationId,
): Effect.Effect<OrganizationPanelOrganization, OrganizationPanelError> {
  return Effect.succeed(
    ORGANIZATIONS.find((organization) => organization.id === organizationId),
  ).pipe(
    Effect.flatMap((organization) =>
      organization
        ? Effect.succeed(organization)
        : Effect.fail(
            panelError("organization-not-found", `Organization "${organizationId}" was not found.`),
          ),
    ),
  );
}

const loadPanelContext = (input: {
  readonly config: ServerConfigShape;
  readonly organizationId: OrganizationId;
}) =>
  Effect.gen(function* () {
    const organization = yield* resolveOrganization(input.organizationId);
    const repositoryRoot = yield* resolveRepositoryRoot(input.config);
    const path = yield* resolveOrganizationPanelPath({
      repositoryRoot,
      organizationId: input.organizationId,
      panelSlug: organization.panelSlug,
    });
    yield* ensureStarterPanel(path, organization);
    const contents = yield* readPanelFile(path);
    return { organization, path, contents };
  });

const resolveRepositoryRoot = (
  config: ServerConfigShape,
): Effect.Effect<string, OrganizationPanelError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwdCandidate = path.resolve(config.cwd);
    const cwdPanelsRoot = path.join(cwdCandidate, PANEL_SOURCE_ROOT);
    if (yield* fs.exists(cwdPanelsRoot).pipe(Effect.orElseSucceed(() => false))) {
      return cwdCandidate;
    }

    const sourceCandidate = path.resolve(import.meta.dirname, "../../..");
    const sourcePanelsRoot = path.join(sourceCandidate, PANEL_SOURCE_ROOT);
    if (yield* fs.exists(sourcePanelsRoot).pipe(Effect.orElseSucceed(() => false))) {
      return sourceCandidate;
    }

    return yield* panelError(
      "panel-file-create-failed",
      "Could not find apps/web organization panel root.",
    );
  });

const ensureStarterPanel = (
  panelPath: OrganizationPanelPath,
  organization: OrganizationPanelOrganization,
): Effect.Effect<void, OrganizationPanelError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(panelPath.panelFileAbsolutePath)
      .pipe(
        Effect.mapError((cause) =>
          panelError("panel-file-create-failed", "Failed to check organization panel file.", cause),
        ),
      );
    if (exists) {
      return;
    }

    yield* fs
      .makeDirectory(panelPath.folderAbsolutePath, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          panelError(
            "panel-file-create-failed",
            "Failed to create organization panel folder.",
            cause,
          ),
        ),
      );
    yield* writeFileStringAtomically({
      filePath: panelPath.panelFileAbsolutePath,
      contents: renderStarterPanelSource(organization),
    }).pipe(
      Effect.mapError((cause) =>
        panelError(
          "panel-file-create-failed",
          "Failed to create starter organization panel.",
          cause,
        ),
      ),
    );
  });

const readPanelFile = (
  panelPath: OrganizationPanelPath,
): Effect.Effect<string, OrganizationPanelError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .readFileString(panelPath.panelFileAbsolutePath)
      .pipe(
        Effect.mapError((cause) =>
          panelError("panel-file-create-failed", "Failed to read organization panel file.", cause),
        ),
      );
  });

const writePanelFile = (
  panelPath: OrganizationPanelPath,
  contents: string,
): Effect.Effect<void, OrganizationPanelError, FileSystem.FileSystem | Path.Path> =>
  writeFileStringAtomically({
    filePath: panelPath.panelFileAbsolutePath,
    contents,
  }).pipe(
    Effect.mapError((cause) =>
      panelError("write-failed", "Failed to write organization panel file.", cause),
    ),
  );

const readStoredVersions = (
  config: ServerConfigShape,
): Effect.Effect<
  readonly StoredOrganizationPanelVersion[],
  OrganizationPanelError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const historyPath = path.join(config.stateDir, PANEL_HISTORY_FILE_NAME);
    const exists = yield* fs.exists(historyPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return [];
    }

    const raw = yield* fs
      .readFileString(historyPath)
      .pipe(
        Effect.mapError((cause) =>
          panelError("history-read-failed", "Failed to read organization panel history.", cause),
        ),
      );
    const versions: StoredOrganizationPanelVersion[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const decoded = yield* decodeStoredOrganizationPanelVersion(trimmed).pipe(
        Effect.mapError((cause) =>
          panelError(
            "history-read-failed",
            `Organization panel history contains invalid JSON: ${cause.message}`,
            cause,
          ),
        ),
      );
      versions.push(decoded);
    }
    return versions;
  });

const appendStoredVersion = (
  config: ServerConfigShape,
  version: StoredOrganizationPanelVersion,
): Effect.Effect<
  OrganizationPanelVersion,
  OrganizationPanelError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const historyPath = path.join(config.stateDir, PANEL_HISTORY_FILE_NAME);
    const previous = yield* fs.exists(historyPath).pipe(
      Effect.flatMap((exists) => (exists ? fs.readFileString(historyPath) : Effect.succeed(""))),
      Effect.mapError((cause) =>
        panelError("history-write-failed", "Failed to read organization panel history.", cause),
      ),
    );
    const encodedVersion = yield* encodeStoredOrganizationPanelVersion(version).pipe(
      Effect.mapError((cause) =>
        panelError(
          "history-write-failed",
          `Failed to encode organization panel history: ${cause.message}`,
          cause,
        ),
      ),
    );
    const nextContents = `${previous}${previous.endsWith("\n") || previous.length === 0 ? "" : "\n"}${encodedVersion}\n`;
    yield* writeFileStringAtomically({ filePath: historyPath, contents: nextContents }).pipe(
      Effect.mapError((cause) =>
        panelError("history-write-failed", "Failed to write organization panel history.", cause),
      ),
    );
    return toPublicVersion(version);
  });

const latestVersionForOrganization = (
  config: ServerConfigShape,
  organizationId: OrganizationId,
): Effect.Effect<
  OrganizationPanelVersion | null,
  OrganizationPanelError,
  FileSystem.FileSystem | Path.Path
> =>
  readStoredVersions(config).pipe(
    Effect.map((versions) => {
      const latest = versions.findLast((version) => version.organizationId === organizationId);
      return latest ? toPublicVersion(latest) : null;
    }),
  );

function toSnapshot(input: {
  readonly context: {
    readonly organization: OrganizationPanelOrganization;
    readonly path: OrganizationPanelPath;
    readonly contents: string;
  };
  readonly now: string;
  readonly latestVersion: OrganizationPanelVersion | null;
}): OrganizationPanelSnapshot {
  const versionId =
    input.latestVersion?.id ??
    OrganizationPanelVersionId.make(`panel-working-${hashContents(input.context.contents)}`);
  return {
    organization: input.context.organization,
    viewer: {
      id: "local-user",
      displayName: "Local user",
      role: "owner",
    },
    runtime: {
      now: input.now,
      environment: "local",
    },
    panel: {
      organizationId: input.context.organization.id,
      panelSlug: input.context.organization.panelSlug,
      panelFilePath: input.context.path.panelFileRelativePath,
      panelImportPath: input.context.path.panelImportPath,
      versionId,
      contentsHash: hashContents(input.context.contents),
      editable: true,
      allowedImports: [...ALLOWED_PANEL_IMPORTS],
    },
    latestVersion: input.latestVersion,
  };
}

function publishSnapshotEvent(snapshot: OrganizationPanelSnapshot): void {
  publishPanelEvent({
    type: "panel.snapshot",
    organizationId: snapshot.organization.id,
    panelSlug: snapshot.organization.panelSlug,
    panelFilePath: snapshot.panel.panelFilePath,
    versionId: snapshot.panel.versionId,
  });
}

function publishPanelEvent(event: OrganizationPanelEvent): void {
  for (const listener of eventSubscribers) {
    listener(event);
  }
}

function toPublicVersion(version: StoredOrganizationPanelVersion): OrganizationPanelVersion {
  const {
    beforeContents: _beforeContents,
    afterContents: _afterContents,
    ...publicVersion
  } = version;
  return publicVersion;
}

function renderStarterPanelSource(organization: OrganizationPanelOrganization): string {
  return `import type { OrganizationPanelProps } from "../_shared/types";

export default function Panel({ organization }: OrganizationPanelProps) {
  return (
    <section className="flex flex-col gap-3 p-6">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Organization panel
      </p>
      <h1 className="text-xl font-semibold">{organization.name}</h1>
      <p className="max-w-2xl text-sm text-muted-foreground">
        ${escapeJsString(organization.name)} has a dedicated editable panel file.
      </p>
    </section>
  );
}
`;
}

function renderPanelSourceFromPrompt(input: {
  readonly organization: OrganizationPanelOrganization;
  readonly prompt: string;
}): string {
  const metrics = extractMetricLabels(input.prompt);
  const metricRows = metrics
    .map(
      (metric, index) =>
        `  { label: ${jsStringLiteral(metric)}, value: ${jsStringLiteral(metricValue(index))}, tone: ${jsStringLiteral(metricTone(index))} },`,
    )
    .join("\n");
  const focusItems = extractFocusItems(input.prompt)
    .map((item) => `  ${jsStringLiteral(item)},`)
    .join("\n");

  return `import type { OrganizationPanelProps } from "../_shared/types";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "../_shared/imports";

const metrics = [
${metricRows}
] as const;

const focusItems = [
${focusItems}
] as const;

export default function Panel({ organization, viewer, runtime }: OrganizationPanelProps) {
  const asOf = runtime.now.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <section className="flex min-w-0 flex-col gap-5 p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {organization.name}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Operating panel</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{viewer.role}</Badge>
          <span>{asOf}</span>
        </div>
      </header>

      <div className="grid gap-3 md:grid-cols-3">
        {metrics.map((metric) => (
          <Card key={metric.label} className="rounded-lg">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm text-muted-foreground">{metric.label}</CardTitle>
            </CardHeader>
            <CardContent className="flex items-end justify-between gap-3 p-4 pt-0">
              <span className="text-2xl font-semibold tracking-tight">{metric.value}</span>
              <Badge variant={metric.tone}>{metric.tone}</Badge>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-lg border border-border bg-card/45 p-4">
          <h2 className="text-sm font-semibold">Current focus</h2>
          <div className="mt-3 grid gap-2">
            {focusItems.map((item) => (
              <div
                key={item}
                className="flex min-h-10 items-center rounded-md border border-border/70 bg-background px-3 text-sm"
              >
                {item}
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card/45 p-4">
          <h2 className="text-sm font-semibold">Panel scope</h2>
          <dl className="mt-3 grid gap-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Organization</dt>
              <dd className="font-medium">{organization.slug}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Runtime</dt>
              <dd className="font-medium">{runtime.environment}</dd>
            </div>
          </dl>
        </section>
      </div>
    </section>
  );
}
`;
}

function extractMetricLabels(prompt: string): readonly string[] {
  const normalized = prompt
    .replace(/[.?!]/gu, " ")
    .replace(/\band\b/giu, ",")
    .split(",")
    .map((part) => titleCase(part.replace(/\b(add|show|include|track|display)\b/giu, "").trim()))
    .filter((part) => part.length > 0 && part.length <= 40);
  const deduped = Array.from(new Set(normalized));
  return (deduped.length > 0 ? deduped : ["Revenue", "Active users", "Open tickets"]).slice(0, 6);
}

function extractFocusItems(prompt: string): readonly string[] {
  const metrics = extractMetricLabels(prompt);
  return metrics.slice(0, 4).map((metric) => `Review ${metric.toLowerCase()} trend`);
}

function titleCase(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toLocaleUpperCase()}${word.slice(1).toLocaleLowerCase()}`)
    .join(" ");
}

function metricValue(index: number): string {
  const values = ["$128K", "24,812", "37", "91%", "14", "6.2h"];
  return values[index % values.length] ?? "0";
}

function metricTone(index: number): "success" | "info" | "warning" {
  const tones = ["success", "info", "warning"] as const;
  return tones[index % tones.length] ?? "info";
}

function createUnifiedDiff(
  relativePath: string,
  beforeContents: string,
  afterContents: string,
): string {
  if (beforeContents === afterContents) {
    return "";
  }
  const beforeLines = beforeContents.split("\n");
  const afterLines = afterContents.split("\n");
  return [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join("\n");
}

function hashContents(contents: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < contents.length; index += 1) {
    hash ^= contents.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function escapeJsString(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/`/gu, "\\`").replace(/\$/gu, "\\$");
}

function jsStringLiteral(value: string): string {
  return `"${value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\r/gu, "\\r")
    .replace(/\n/gu, "\\n")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029")}"`;
}

function panelError(
  code: OrganizationPanelError["code"],
  message: string,
  cause?: unknown,
): OrganizationPanelError {
  return new OrganizationPanelError({
    code,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}
