import {
  type ModelSelection,
  OrganizationId,
  OrganizationPanelDocument as OrganizationPanelDocumentSchema,
  OrganizationPanelError,
  OrganizationPanelSlug,
  OrganizationPanelTurnId,
  OrganizationPanelVersion as OrganizationPanelVersionSchema,
  OrganizationPanelVersionId,
  type ProviderRuntimeEvent,
  ThreadId,
  type TurnId,
  type OrganizationPanelEvent,
  type OrganizationPanelGetResult,
  type OrganizationPanelHistoryListResult,
  type OrganizationPanelDocument,
  type OrganizationPanelOrganization,
  type OrganizationPanelRollbackResult,
  type OrganizationPanelSnapshot,
  type OrganizationPanelTurnStartResult,
  type OrganizationPanelVersion,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import type { ServerConfigShape } from "./config.ts";
import type { ProviderServiceShape } from "./provider/Services/ProviderService.ts";

export interface OrganizationPanelPath {
  readonly organizationId: OrganizationId;
  readonly panelSlug: OrganizationPanelSlug;
  readonly folderAbsolutePath: string;
  readonly panelFileAbsolutePath: string;
  readonly panelImportPath: string;
  readonly panelFileRelativePath: string;
}

const PANEL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PANEL_STORAGE_ROOT = "organization-panels";
const PANEL_FILE_NAME = "panel.json";
const PANEL_HISTORY_FILE_NAME = "organization-panel-versions.ndjson";

type OrganizationPanelSettings = Pick<ServerSettings, "sidebarProjectFolders">;

interface OrganizationPanelAgentRuntime {
  readonly providerService: Pick<
    ProviderServiceShape,
    "startSession" | "sendTurn" | "interruptTurn" | "stopSession" | "streamEvents"
  >;
  readonly modelSelection: ModelSelection;
}

interface ActiveOrganizationPanelTurn {
  readonly turnId: OrganizationPanelTurnId;
  providerThreadId: ThreadId | null;
  providerTurnId: TurnId | null;
  stopRequested: boolean;
  failurePublished: boolean;
}

function hashOrganizationId(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function toOrganizationPanelSlug(value: string): OrganizationPanelSlug {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
  const safeBase = normalized.length > 0 ? normalized : "organization";
  const slug = PANEL_SLUG_PATTERN.test(value)
    ? value
    : `${safeBase.slice(0, 48).replace(/-+$/u, "")}-${hashOrganizationId(value)}`;
  return OrganizationPanelSlug.make(slug);
}

export function resolveOrganizationPanelOrganization(input: {
  readonly organizationId: OrganizationId;
  readonly settings?: OrganizationPanelSettings | undefined;
}): OrganizationPanelOrganization | null {
  const folder = input.settings?.sidebarProjectFolders.find(
    (candidate) => candidate.id === input.organizationId,
  );
  if (!folder) {
    return null;
  }

  const panelSlug = toOrganizationPanelSlug(folder.id);
  return {
    id: input.organizationId,
    slug: String(panelSlug),
    name: folder.name,
    panelSlug,
  };
}

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
const OrganizationPanelDocumentJson = Schema.fromJsonString(OrganizationPanelDocumentSchema);
const decodeOrganizationPanelDocument = Schema.decodeUnknownEffect(OrganizationPanelDocumentJson);
const encodeOrganizationPanelDocument = Schema.encodeEffect(OrganizationPanelDocumentJson);

const eventSubscribers = new Set<(event: OrganizationPanelEvent) => void>();
const activeTurnsByOrganization = new Map<OrganizationId, ActiveOrganizationPanelTurn>();
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

export const resolveOrganizationPanelPath = (input: {
  readonly storageRoot: string;
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

    const panelsRoot = path.resolve(input.storageRoot, PANEL_STORAGE_ROOT);
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
      panelImportPath: `runtime:${panelSlug}`,
      panelFileRelativePath: `${PANEL_STORAGE_ROOT}/${panelSlug}/${PANEL_FILE_NAME}`,
    } satisfies OrganizationPanelPath;
  });

export const getOrganizationPanel = (input: {
  readonly config: ServerConfigShape;
  readonly organizationId: OrganizationId;
  readonly settings?: OrganizationPanelSettings | undefined;
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
  readonly settings?: OrganizationPanelSettings | undefined;
  readonly limit?: number | undefined;
}): Effect.Effect<
  OrganizationPanelHistoryListResult,
  OrganizationPanelError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    yield* resolveOrganization(input.organizationId, input.settings);
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
  readonly settings?: OrganizationPanelSettings | undefined;
  readonly agent: OrganizationPanelAgentRuntime;
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

        const activeTurn: ActiveOrganizationPanelTurn = {
          turnId: input.turnId,
          providerThreadId: null,
          providerTurnId: null,
          stopRequested: false,
          failurePublished: false,
        };
        activeTurnsByOrganization.set(input.organizationId, activeTurn);
        const runTurn = Effect.gen(function* () {
          const context = yield* loadPanelContext(input);
          const beforeContents = yield* readPanelFile(context.path);

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
            message: "Starting organization panel agent.",
          });

          const agentResult = yield* runOrganizationPanelAgent({
            activeTurn,
            agent: input.agent,
            organizationId: input.organizationId,
            organization: context.organization,
            panelPath: context.path,
            prompt: input.prompt,
            turnId: input.turnId,
            beforeContents,
          });
          const afterDocument = agentResult.afterDocument;
          const validationErrors = validateOrganizationPanelDocument(afterDocument);
          const afterContents = agentResult.afterContents;

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
            context: { ...context, contents: afterContents, document: afterDocument },
            now: input.now,
            latestVersion: version,
          });
          publishSnapshotEvent(snapshot);
          return { turnId: input.turnId, version, snapshot };
        });

        return yield* runTurn.pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (error.code !== "validation-failed" && !activeTurn.failurePublished) {
                activeTurn.failurePublished = true;
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
            Effect.gen(function* () {
              if (activeTurn.providerThreadId !== null) {
                yield* input.agent.providerService
                  .stopSession({ threadId: activeTurn.providerThreadId })
                  .pipe(Effect.ignoreCause({ log: true }));
              }
              const current = activeTurnsByOrganization.get(input.organizationId);
              if (current === activeTurn) {
                activeTurnsByOrganization.delete(input.organizationId);
              }
            }),
          ),
        );
      }),
    );
  });

export function stopOrganizationPanelTurn(input: {
  readonly organizationId: OrganizationId;
  readonly turnId: OrganizationPanelTurnId;
  readonly agent?: Pick<OrganizationPanelAgentRuntime, "providerService"> | undefined;
}): Effect.Effect<{ readonly stopped: boolean }, OrganizationPanelError> {
  return Effect.gen(function* () {
    const activeTurn = activeTurnsByOrganization.get(input.organizationId);
    if (!activeTurn || activeTurn.turnId !== input.turnId) {
      return { stopped: false };
    }
    activeTurn.stopRequested = true;
    if (!activeTurn.failurePublished) {
      activeTurn.failurePublished = true;
      publishPanelEvent({
        type: "turn.failed",
        organizationId: input.organizationId,
        turnId: input.turnId,
        reason: "Panel turn stopped.",
      });
    }
    if (input.agent && activeTurn.providerThreadId !== null) {
      yield* input.agent.providerService
        .interruptTurn({
          threadId: activeTurn.providerThreadId,
          ...(activeTurn.providerTurnId !== null ? { turnId: activeTurn.providerTurnId } : {}),
        })
        .pipe(Effect.ignoreCause({ log: true }));
    }
    return { stopped: true };
  });
}

export const rollbackOrganizationPanel = (input: {
  readonly config: ServerConfigShape;
  readonly organizationId: OrganizationId;
  readonly settings?: OrganizationPanelSettings | undefined;
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

        const rollbackDocument = yield* decodePanelDocument(target.beforeContents).pipe(
          Effect.mapError((cause) =>
            panelError("rollback-failed", "Previous organization panel file was invalid.", cause),
          ),
        );
        const validationErrors = validateOrganizationPanelDocument(rollbackDocument);
        if (validationErrors.length > 0) {
          return yield* panelError(
            "rollback-failed",
            "Previous organization panel document failed validation.",
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
          context: { ...context, contents: afterContents, document: rollbackDocument },
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

function resolveOrganization(
  organizationId: OrganizationId,
  settings?: OrganizationPanelSettings | undefined,
): Effect.Effect<OrganizationPanelOrganization, OrganizationPanelError> {
  return Effect.succeed(resolveOrganizationPanelOrganization({ organizationId, settings })).pipe(
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
  readonly settings?: OrganizationPanelSettings | undefined;
}) =>
  Effect.gen(function* () {
    const organization = yield* resolveOrganization(input.organizationId, input.settings);
    const path = yield* resolveOrganizationPanelPath({
      storageRoot: input.config.stateDir,
      organizationId: input.organizationId,
      panelSlug: organization.panelSlug,
    });
    yield* ensureStarterPanel(path, organization);
    const contents = yield* readPanelFile(path);
    const document = yield* decodePanelDocument(contents);
    return { organization, path, contents, document };
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
      const existingDocument = yield* readPanelFile(panelPath).pipe(
        Effect.flatMap(decodePanelDocument),
        Effect.catch(() => Effect.succeed(null)),
      );
      if (existingDocument && isLegacyStarterPanelDocument(existingDocument, organization)) {
        yield* writeStarterPanelDocument(panelPath);
      }
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
    yield* writeStarterPanelDocument(panelPath);
  });

const decodePanelDocument = (
  contents: string,
): Effect.Effect<OrganizationPanelDocument, OrganizationPanelError> =>
  decodeOrganizationPanelDocument(contents).pipe(
    Effect.mapError((cause) =>
      panelError(
        "panel-file-create-failed",
        "Organization panel file contains invalid JSON.",
        cause,
      ),
    ),
  );

const encodePanelDocument = (
  document: OrganizationPanelDocument,
): Effect.Effect<string, OrganizationPanelError> =>
  encodeOrganizationPanelDocument(document).pipe(
    Effect.mapError((cause) =>
      panelError(
        "panel-file-create-failed",
        `Failed to encode organization panel document: ${cause.message}`,
        cause,
      ),
    ),
  );

function validateOrganizationPanelDocument(document: OrganizationPanelDocument): readonly string[] {
  const errors: string[] = [];
  if (document.metrics.length > 6) {
    errors.push("Organization panels can include at most 6 metrics.");
  }
  if (document.focusItems.length > 8) {
    errors.push("Organization panels can include at most 8 focus items.");
  }
  return errors;
}

const writeStarterPanelDocument = (
  panelPath: OrganizationPanelPath,
): Effect.Effect<void, OrganizationPanelError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    yield* writeFileStringAtomically({
      filePath: panelPath.panelFileAbsolutePath,
      contents: yield* encodePanelDocument(renderStarterPanelDocument()),
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

const runOrganizationPanelAgent = (input: {
  readonly activeTurn: ActiveOrganizationPanelTurn;
  readonly agent: OrganizationPanelAgentRuntime;
  readonly organizationId: OrganizationId;
  readonly organization: OrganizationPanelOrganization;
  readonly panelPath: OrganizationPanelPath;
  readonly prompt: string;
  readonly turnId: OrganizationPanelTurnId;
  readonly beforeContents: string;
}): Effect.Effect<
  {
    readonly afterContents: string;
    readonly afterDocument: OrganizationPanelDocument;
  },
  OrganizationPanelError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const providerThreadId = ThreadId.make(`organization-panel:${input.turnId}`);
      input.activeTurn.providerThreadId = providerThreadId;
      const completion = yield* Deferred.make<ProviderRuntimeEvent, OrganizationPanelError>();

      yield* Stream.runForEach(
        input.agent.providerService.streamEvents.pipe(
          Stream.filter((event) => event.threadId === providerThreadId),
        ),
        (event) =>
          observeOrganizationPanelAgentEvent({
            event,
            completion,
            organizationId: input.organizationId,
            turnId: input.turnId,
          }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* input.agent.providerService
        .startSession(providerThreadId, {
          threadId: providerThreadId,
          providerInstanceId: input.agent.modelSelection.instanceId,
          cwd: input.panelPath.folderAbsolutePath,
          modelSelection: input.agent.modelSelection,
          runtimeMode: "full-access",
        })
        .pipe(
          Effect.mapError((cause) =>
            panelError("write-failed", "Failed to start organization panel agent.", cause),
          ),
        );

      if (input.activeTurn.stopRequested) {
        return yield* panelError("turn-not-found", "Panel turn stopped.");
      }

      const providerTurn = yield* input.agent.providerService
        .sendTurn({
          threadId: providerThreadId,
          input: buildOrganizationPanelAgentPrompt({
            organization: input.organization,
            panelPath: input.panelPath,
            prompt: input.prompt,
            beforeContents: input.beforeContents,
          }),
          modelSelection: input.agent.modelSelection,
          interactionMode: "default",
        })
        .pipe(
          Effect.mapError((cause) =>
            panelError("write-failed", "Failed to send organization panel agent turn.", cause),
          ),
        );
      input.activeTurn.providerTurnId = providerTurn.turnId;

      const completed = yield* Deferred.await(completion).pipe(Effect.timeoutOption("20 minutes"));
      if (Option.isNone(completed)) {
        return yield* panelError("write-failed", "Organization panel agent timed out.");
      }
      if (input.activeTurn.stopRequested) {
        return yield* panelError("turn-not-found", "Panel turn stopped.");
      }

      const afterContents = yield* readPanelFile(input.panelPath);
      const afterDocument = yield* decodePanelDocument(afterContents).pipe(
        Effect.mapError((cause) =>
          panelError("validation-failed", "Agent wrote invalid organization panel JSON.", cause),
        ),
      );
      return { afterContents, afterDocument };
    }),
  );

const observeOrganizationPanelAgentEvent = (input: {
  readonly event: ProviderRuntimeEvent;
  readonly completion: Deferred.Deferred<ProviderRuntimeEvent, OrganizationPanelError>;
  readonly organizationId: OrganizationId;
  readonly turnId: OrganizationPanelTurnId;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const message = organizationPanelAgentEventMessage(input.event);
    if (message) {
      publishPanelEvent({
        type: "turn.delta",
        organizationId: input.organizationId,
        turnId: input.turnId,
        message,
      });
    }

    if (input.event.type === "turn.completed") {
      if (input.event.payload.state === "completed") {
        yield* Deferred.succeed(input.completion, input.event);
        return;
      }
      yield* Deferred.fail(
        input.completion,
        panelError(
          "write-failed",
          input.event.payload.errorMessage ??
            input.event.payload.stopReason ??
            `Organization panel agent finished with state "${input.event.payload.state}".`,
        ),
      );
      return;
    }

    if (input.event.type === "turn.aborted") {
      yield* Deferred.fail(
        input.completion,
        panelError(
          "write-failed",
          `Organization panel agent aborted: ${input.event.payload.reason}`,
        ),
      );
      return;
    }

    if (input.event.type === "runtime.error") {
      yield* Deferred.fail(
        input.completion,
        panelError(
          "write-failed",
          `Organization panel agent error: ${input.event.payload.message}`,
        ),
      );
    }
  });

function organizationPanelAgentEventMessage(event: ProviderRuntimeEvent): string | null {
  switch (event.type) {
    case "session.started":
      return "Agent session started.";
    case "turn.started":
      return event.payload.model ? `Agent started with ${event.payload.model}.` : "Agent started.";
    case "item.completed":
      return event.payload.title ?? event.payload.detail ?? null;
    case "tool.progress":
      return event.payload.summary ?? event.payload.toolName ?? null;
    case "tool.summary":
      return event.payload.summary;
    case "request.opened":
      return event.payload.detail ?? "Agent requested approval.";
    case "runtime.warning":
      return event.payload.message;
    case "runtime.error":
      return event.payload.message;
    default:
      return null;
  }
}

function buildOrganizationPanelAgentPrompt(input: {
  readonly organization: OrganizationPanelOrganization;
  readonly panelPath: OrganizationPanelPath;
  readonly prompt: string;
  readonly beforeContents: string;
}): string {
  return `You are editing the organization panel for ${input.organization.name}.

Update only ./panel.json in the current working directory. Do not create React, TSX, or source files.

The file must remain valid JSON with exactly this shape:
{
  "title": "non-empty string",
  "description": "string or null",
  "metrics": [
    { "label": "non-empty string", "value": "non-empty string", "tone": "success|info|warning" }
  ],
  "focusItems": ["non-empty string"]
}

Constraints:
- At most 6 metrics.
- At most 8 focusItems.
- Use only the tones "success", "info", or "warning".
- Keep the JSON human-readable.
- If the request does not ask for metrics or focus items, leave those arrays empty.

Panel file: ${input.panelPath.panelFileRelativePath}

Current panel.json:
\`\`\`json
${input.beforeContents}
\`\`\`

User request:
${input.prompt}

Edit panel.json now and finish after the file is valid.`;
}

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
    readonly document: OrganizationPanelDocument;
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
      document: input.context.document,
      editable: true,
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

function renderStarterPanelDocument(): OrganizationPanelDocument {
  return {
    title: "Organization panel",
    description: null,
    metrics: [],
    focusItems: [],
  };
}

function isLegacyStarterPanelDocument(
  document: OrganizationPanelDocument,
  organization: OrganizationPanelOrganization,
): boolean {
  return (
    document.title === "Organization panel" &&
    document.description === `${organization.name} has a dedicated editable panel.` &&
    document.metrics.length === 3 &&
    document.metrics[0]?.label === "Revenue" &&
    document.metrics[1]?.label === "Active users" &&
    document.metrics[2]?.label === "Open tickets" &&
    document.focusItems.length === 3 &&
    document.focusItems[0] === "Review revenue trend" &&
    document.focusItems[1] === "Review active users trend" &&
    document.focusItems[2] === "Review open tickets trend"
  );
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
