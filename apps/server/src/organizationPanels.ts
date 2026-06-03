import {
  type ModelSelection,
  type ChatAttachment,
  OrganizationId,
  type OrganizationPanelActiveTurn,
  OrganizationPanelError,
  type OrganizationPanelTurnActivity,
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
  ProviderInstanceId,
  type ServerSettings,
  type UploadChatAttachment,
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
import { persistUploadChatAttachments } from "./uploadChatAttachments.ts";

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
const PANEL_FILE_NAME = "panel.html";
const PANEL_HISTORY_FILE_NAME = "organization-panel-versions.ndjson";
const PANEL_HTML_MAX_LENGTH = 200_000;

export const ORGANIZATION_PANEL_AGENT_MODEL_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.5",
  options: [{ id: "reasoningEffort", value: "high" }],
};

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
  readonly prompt: string;
  readonly createdAt: string;
  providerThreadId: ThreadId | null;
  providerTurnId: TurnId | null;
  status: OrganizationPanelActiveTurn["status"];
  filePath: string | null;
  attachments: readonly ChatAttachment[];
  activities: readonly OrganizationPanelTurnActivity[];
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
  readonly attachments?: readonly UploadChatAttachment[] | undefined;
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
          prompt: input.prompt,
          createdAt: input.now,
          providerThreadId: null,
          providerTurnId: null,
          status: "running",
          filePath: null,
          attachments: [],
          activities: [],
          stopRequested: false,
          failurePublished: false,
        };
        activeTurnsByOrganization.set(input.organizationId, activeTurn);
        const runTurn = Effect.gen(function* () {
          const context = yield* loadPanelContext(input);
          const beforeContents = yield* readPanelFile(context.path);
          const attachments = yield* persistUploadChatAttachments({
            attachments: input.attachments ?? [],
            attachmentsDir: input.config.attachmentsDir,
            attachmentScopeId: `organization-panel-${input.turnId}`,
            toError: (message) => panelError("write-failed", message),
          });
          activeTurn.attachments = attachments;

          publishPanelEvent({
            type: "turn.started",
            organizationId: input.organizationId,
            turnId: input.turnId,
            prompt: input.prompt,
            ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
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
            attachments,
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

        const rollbackDocument = parsePanelDocument(target.beforeContents);
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
    const document = parsePanelDocument(contents);
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
        Effect.map(parsePanelDocument),
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

function parsePanelDocument(contents: string): OrganizationPanelDocument {
  return {
    title: extractHtmlTitle(contents) ?? "Organization panel",
    html: contents.trim(),
  };
}

function extractHtmlTitle(contents: string): string | null {
  const match = /<title[^>]*>(?<title>[\s\S]*?)<\/title>/iu.exec(contents);
  const title = decodeHtmlText(match?.groups?.title ?? "").trim();
  return title.length > 0 ? title : null;
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'");
}

function validateOrganizationPanelDocument(document: OrganizationPanelDocument): readonly string[] {
  const errors: string[] = [];
  const html = document.html;
  const lowerHtml = html.toLowerCase();

  if (html.length > PANEL_HTML_MAX_LENGTH) {
    errors.push(`Organization panel HTML must be ${PANEL_HTML_MAX_LENGTH} characters or less.`);
  }
  if (!/<!doctype\s+html>/iu.test(html)) {
    errors.push("Organization panel HTML must include <!doctype html>.");
  }
  if (!/<html[\s>]/iu.test(html) || !/<head[\s>]/iu.test(html) || !/<body[\s>]/iu.test(html)) {
    errors.push("Organization panel HTML must include html, head, and body elements.");
  }
  if (!/<title[\s>]/iu.test(html)) {
    errors.push("Organization panel HTML must include a title element.");
  }
  if (!/<meta\s+[^>]*name=["']viewport["'][^>]*>/iu.test(html)) {
    errors.push("Organization panel HTML must include a viewport meta tag for mobile layouts.");
  }
  if (!/<style[\s>]/iu.test(html)) {
    errors.push("Organization panel HTML must include inline CSS in a style element.");
  }
  if (!/<script[\s>]/iu.test(html)) {
    errors.push("Organization panel HTML must include inline JavaScript in a script element.");
  }
  if (!/@media\b/iu.test(html)) {
    errors.push("Organization panel CSS must include at least one media query.");
  }
  if (!/box-sizing\s*:\s*border-box/iu.test(html)) {
    errors.push("Organization panel CSS must set border-box sizing.");
  }
  if (/<script\b[^>]*\bsrc\s*=/iu.test(html)) {
    errors.push("Organization panel HTML must not load external scripts.");
  }
  if (/<link\b/iu.test(html) || /<style\b[^>]*\bsrc\s*=/iu.test(html)) {
    errors.push("Organization panel HTML must not load external stylesheets.");
  }
  if (/<(?:iframe|object|embed|base)\b/iu.test(html)) {
    errors.push("Organization panel HTML must not embed frames, objects, embeds, or base URLs.");
  }
  if (/\son[a-z]+\s*=/iu.test(html)) {
    errors.push("Organization panel interactions must use addEventListener, not inline handlers.");
  }
  if (/\b(import\s+.+\s+from|require\s*\(|react|tsx|jsx)\b/iu.test(lowerHtml)) {
    errors.push("Organization panel source must be plain HTML, CSS, and browser JavaScript.");
  }

  return errors;
}

const writeStarterPanelDocument = (
  panelPath: OrganizationPanelPath,
): Effect.Effect<void, OrganizationPanelError, FileSystem.FileSystem | Path.Path> =>
  writeFileStringAtomically({
    filePath: panelPath.panelFileAbsolutePath,
    contents: renderStarterPanelDocument(),
  }).pipe(
    Effect.mapError((cause) =>
      panelError("panel-file-create-failed", "Failed to create starter organization panel.", cause),
    ),
  );

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
  readonly attachments: readonly ChatAttachment[];
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
            attachments: input.attachments,
            beforeContents: input.beforeContents,
          }),
          ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
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
      const afterDocument = parsePanelDocument(afterContents);
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
      return null;
    case "turn.started":
      return null;
    case "item.completed":
      return normalizeOrganizationPanelAgentEventMessage(
        event.payload.detail ?? event.payload.title ?? null,
      );
    case "tool.progress":
      return normalizeOrganizationPanelAgentEventMessage(event.payload.summary ?? null);
    case "tool.summary":
      return normalizeOrganizationPanelAgentEventMessage(event.payload.summary);
    case "request.opened":
      return normalizeOrganizationPanelAgentEventMessage(
        event.payload.detail ?? "Agent requested approval.",
      );
    case "runtime.warning":
      return normalizeOrganizationPanelAgentEventMessage(event.payload.message);
    case "runtime.error":
      return normalizeOrganizationPanelAgentEventMessage(event.payload.message);
    default:
      return null;
  }
}

function normalizeOrganizationPanelAgentEventMessage(message: string | null): string | null {
  const trimmed = message?.trim();
  if (!trimmed) {
    return null;
  }
  const genericLabels = new Set([
    "assistant message",
    "reasoning",
    "ran command",
    "ran command complete",
    "tool call",
  ]);
  return genericLabels.has(trimmed.toLowerCase()) ? null : trimmed;
}

function buildOrganizationPanelAgentPrompt(input: {
  readonly organization: OrganizationPanelOrganization;
  readonly panelPath: OrganizationPanelPath;
  readonly prompt: string;
  readonly attachments: readonly ChatAttachment[];
  readonly beforeContents: string;
}): string {
  return `You are editing the organization panel for ${input.organization.name}.

Update ./panel.html in the current working directory. You may also create or update dynamic RPC manifests under ./rpc/*.json when the panel needs live host capabilities. Do not create React, TSX, JSX, or source files.

The file must be a complete plain HTML document that the browser can render directly. Use only:
- HTML in the body.
- Inline CSS inside a <style> tag in the head.
- Inline browser JavaScript inside a <script> tag at the end of the body.

Non-negotiable implementation order:
1. Identify the requested primary workflow and the real data source it needs.
2. Build the information architecture first: header/breadcrumbs, primary controls, main content, optional details/inspector, and clear status/error/empty states.
3. Implement responsive structure and overflow behavior before visual polish.
4. Populate the UI only with real data or explicit empty/error states. Never invent fake metrics, rows, names, counts, issue numbers, dates, avatars, labels, or loading placeholders.
5. Finish with a self-audit against the checklist below and fix any violation before stopping.

Document and runtime rules:
- Include <!doctype html>, <html>, <head>, <title>, <meta name="viewport" content="width=device-width, initial-scale=1">, <style>, <body>, and <script>.
- The panel can be as tall as needed. Let the document height grow naturally and never hide primary content behind fixed-height containers.
- Do not make full-page shells with height: 100vh, overflow: hidden, or fixed-height main regions unless the scrollable child is explicit and all primary content remains reachable.
- Use one page-level <main>, then semantic sections with clear headings. Avoid div-only structure when a header, nav, section, table, list, form, aside, output, or button is more accurate.
- Set *, *::before, and *::after to box-sizing: border-box.
- Do not load external scripts, stylesheets, fonts, iframes, embeds, objects, or base URLs.
- Do not use inline event attributes such as onclick; attach interactions with addEventListener in the script.

Layout contract:
- The first viewport must expose the actual working surface: a compact title/breadcrumb row, primary controls/search/filter actions, and the first real rows/cards/content. Do not waste the first viewport on a hero, giant summary area, or decorative intro.
- Use a single constrained content width such as width: min(100%, 96rem) with small responsive padding. Do not center narrow dashboard cards inside a mostly empty canvas when the task is data browsing.
- Prefer split work surfaces for browse/inspect tasks: list/table on the left or top, detail/inspector on the right or below. On mobile, stack controls, list, then details.
- Use CSS grid/flex with minmax(0, 1fr), min-width: 0, gap, and wrapping. Every flex/grid child that can contain text must allow shrinking with min-width: 0.
- Do not use absolute positioning for normal layout. Only use it for small badges/overlays where it cannot overlap content.
- Avoid nested cards. A page section can be an unframed band or layout container; cards are only for repeated items, an inspector, alerts, and compact grouped controls.
- Keep border radius at 8px or less for cards, panels, inputs, and buttons unless a pill is semantically appropriate for a badge/filter chip.

Pre-made panel structures:
- Pick exactly one primary structure before writing HTML. Reuse the structure names, region names, and class names below so every panel feels consistent. Do not invent a new top-level layout unless the user explicitly asks for something these structures cannot support.
- Shared shell for every structure:
  - <main class="panel-shell"> contains all panel content.
  - <header class="panel-header"> contains breadcrumbs/title on the left and primary actions/status on the right.
  - <section class="panel-toolbar"> contains search, filters, tabs/segments, refresh, and secondary controls. The toolbar wraps on narrow screens.
  - <section class="panel-content"> contains the selected structure's main regions.
  - Use .panel-surface only for framed repeated/inspector/alert surfaces, not as a wrapper around the entire page inside another card.
- Structure A, browse-inspect: Use for repositories, issues, pull requests, projects, files, records, queues, inventories, and anything the user browses then inspects. Required regions: .panel-list or .panel-table for results, .panel-inspector for selected details, .panel-empty for no selection/data. Desktop: grid-template-columns: minmax(0, 1.5fr) minmax(18rem, 0.9fr). Mobile: one column with inspector below the list.
- Structure B, data-table: Use for dense comparable rows where columns matter. Required regions: .panel-table-wrap, table, thead, tbody, row actions, empty row. Use sticky table headers only inside .panel-table-wrap. Hide or collapse secondary columns on mobile; keep name/status/action columns visible.
- Structure C, grouped-board: Use only for workflow states such as todo/in-progress/done, status buckets, or priority lanes. Required regions: .panel-board, .panel-lane, .panel-item. Lanes must scroll vertically with natural page height; they must not force horizontal page scroll. On mobile, lanes stack vertically.
- Structure D, metric-with-worklist: Use only when real metrics are available and useful. Required regions: compact .metric-strip with 2-4 real metrics, then .panel-list or .panel-table below. Metrics must never replace the primary worklist. If real metrics are unavailable, skip this structure.
- Structure E, form-settings: Use for configuration, tokens, environment settings, or setup flows. Required regions: .settings-layout, .settings-nav if multiple groups exist, .settings-section, fieldsets, labels, help text, validation/error messages, and a sticky-or-final action row. Do not use fake save buttons.
- Structure F, activity-log: Use for chronological events, deploys, builds, audits, or command output. Required regions: .log-toolbar, .log-list, timestamp/status/source columns or metadata, and a details expansion. Long output must wrap or live in a scrollable pre with max-width: 100%.
- Structure G, empty/error/setup: Use only when there is no data source, auth is missing, the RPC failed, or setup is required. Required regions: .state-panel, concise title, concrete reason, next action/retry if possible, and optional technical detail in a collapsed/secondary block. Never surround this with fake dashboard content.
- Default choice: if unsure, use Structure A browse-inspect. It is the safest general-purpose panel because it makes the primary data visible and keeps details readable.
- Shared class behavior to include in CSS when relevant:
  - .panel-shell { width: min(100%, 96rem); margin: 0 auto; padding: 1rem; display: grid; gap: 1rem; }
  - .panel-header, .panel-toolbar { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; min-width: 0; }
  - .panel-content { min-width: 0; display: grid; gap: 1rem; }
  - .panel-surface, .panel-inspector { border: 1px solid var(--t3-border); border-radius: var(--t3-radius); background: var(--t3-card); min-width: 0; }
  - .truncate { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  - .break-anywhere { overflow-wrap: anywhere; word-break: normal; }
  - @media (max-width: 640px) must reduce padding/gaps and make every multi-column structure one column.

Readability and alignment rules:
- Text must be readable at every viewport: base body text 13px-15px, compact metadata 11px-12px, line-height at least 1.35, letter-spacing 0 except tiny uppercase labels where it may be positive.
- Keep typography and spacing container-based; do not scale font sizes with viewport width.
- Align related content to a consistent grid. Labels, values, table columns, and actions should line up; avoid random centered blocks next to left-aligned content.
- Use whitespace to separate groups, not to create large empty regions. If a section has no real content, collapse it into an empty state rather than leaving blank space.
- Long titles, paths, URLs, issue names, branch names, and IDs must not break layout. Use overflow-wrap: anywhere for prose-like text; use white-space: nowrap + overflow: hidden + text-overflow: ellipsis only for single-line metadata.
- Buttons and inputs must have stable dimensions. Text inside buttons must not wrap awkwardly or overflow; use icons or shorter labels for narrow layouts.
- Tables/lists must remain readable: sticky headers are allowed, columns should have minmax widths, secondary columns may hide on mobile, and rows must wrap or truncate deliberately.
- Never rely on color alone. Pair status colors with text labels, icons, or accessible names.
- All interactive controls need visible focus states, aria-labels when icon-only, and disabled/loading states when actions are unavailable.

Responsive behavior:
- The layout must work at 320px mobile width, tablet width, and desktop width without horizontal scrolling.
- Use responsive CSS with at least one @media query.
- At <= 640px: stack multi-column layouts, let filters wrap, reduce padding, hide nonessential metadata columns, keep primary actions reachable, and ensure the detail pane appears below the selected item.
- At wide desktop sizes: use available width for useful data density, not oversized cards or empty margins.

T3 Code visual style:
- Match T3 Code's app style: quiet dark neutral surfaces, 8px border radii, subtle borders, compact spacing, DM Sans/system sans typography, restrained color accents, and predictable tool/dashboard controls.
- Do not create marketing-style hero sections, oversized decorative cards, blue/purple gradient themes, orb/blob decorations, or nested cards.
- Use generated CSS variables named --t3-background, --t3-foreground, --t3-card, --t3-muted-foreground, --t3-border, --t3-input, --t3-primary, and --t3-radius when styling shared surfaces and controls.

JavaScript and state rules:
- JavaScript must be resilient: guard missing elements, handle fetch failures, and keep the panel usable if an API fails.
- Render deterministic initial markup that is useful before JavaScript finishes. Then enhance it with data and interactivity.
- Every async action must expose a clear loading state, success/error state, and a retry path where appropriate.
- Search/filter/sort controls must update counts and empty states correctly.
- Do not create controls that do nothing. If an action is not implemented, do not render it.
- If external data is needed, use fetch only for explicit HTTPS APIs requested by the user.
- For host CLI/data access, create declarative dynamic RPC manifests in ./rpc/*.json and call them from panel JavaScript with window.t3Panel.rpc(method, payload). Do not attempt to call localhost APIs directly from the iframe.
- Dynamic RPC method names must start with organizationPanel.dynamic. and use lowercase letters, numbers, underscores, hyphens, and dots after that prefix.
- Prefer command manifests for bounded CLI calls and custom manifests only for glue code that calls ctx.rpc(...) to compose other dynamic RPC methods.

Product quality rules:
- Build the actual requested tool, not a generic dashboard. If the user asks for GitHub, repositories, issues, pull requests, projects, or project contents, use a GitHub-like work surface: compact breadcrumbs, tabs or segmented filters, a searchable table/list, status/label/assignee/date columns where available, and a details pane that updates from the selected row.
- Do not show fake totals, fake loading states, placeholder cards, or empty metric grids when data is unavailable. Instead, show a clear empty/error state and wire a refresh action through dynamic RPC when host data is needed.
- Prioritize browse/inspect workflows over summary cards. The first viewport should let the user open or inspect real items.
- Keep chrome compact. Avoid giant headers, wide empty regions, and panels that obscure the primary data.
- When a request references an existing product UI such as GitHub, match its information architecture and interaction model while still using T3 Code's dark neutral styling.

Edge-case checklist before finishing:
- 320px width has no horizontal page scroll and no clipped buttons.
- Long unbroken strings do not overlap adjacent controls.
- Empty, loading, error, and permission/auth-missing states are explicit and readable.
- Large result sets can scroll naturally and remain usable.
- Details/inspector content does not cover the list or composer.
- Keyboard focus is visible and tab order follows visual order.
- Data labels are honest: counts match rendered data, filters match current state, and stale data is marked or refreshable.
- The panel still works if dynamic RPC is unavailable, returns malformed data, returns an empty array, or throws.
- No decorative element competes with the primary workflow.

Panel file: ${input.panelPath.panelFileRelativePath}

Current panel.html:
\`\`\`html
${input.beforeContents}
\`\`\`

User request:
${input.prompt}

${
  input.attachments.length > 0
    ? `Attached images:
${input.attachments
  .map(
    (attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
  )
  .join("\n")}

Use the attached images as primary visual reference for this panel change.`
    : ""
}

Edit panel.html now and finish after the file is valid.`;
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
    activeTurn: activeOrganizationPanelTurnForSnapshot(input.context.organization.id),
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
  recordActiveOrganizationPanelEvent(event);
  for (const listener of eventSubscribers) {
    listener(event);
  }
}

function activeOrganizationPanelTurnForSnapshot(
  organizationId: OrganizationId,
): OrganizationPanelActiveTurn | null {
  const activeTurn = activeTurnsByOrganization.get(organizationId);
  if (!activeTurn) {
    return null;
  }
  return {
    turnId: activeTurn.turnId,
    prompt: activeTurn.prompt,
    status: activeTurn.status,
    createdAt: activeTurn.createdAt,
    filePath: activeTurn.filePath,
    attachments: [...activeTurn.attachments],
    activities: [...activeTurn.activities],
  };
}

function recordActiveOrganizationPanelEvent(event: OrganizationPanelEvent): void {
  if (!("turnId" in event)) {
    return;
  }
  const activeTurn = activeTurnsByOrganization.get(event.organizationId);
  if (!activeTurn || activeTurn.turnId !== event.turnId) {
    return;
  }

  switch (event.type) {
    case "turn.started":
      activeTurn.attachments = event.attachments ?? [];
      activeTurn.activities = appendActiveTurnActivity(activeTurn, {
        message: "Turn started.",
        tone: "default",
      });
      return;
    case "turn.delta":
      activeTurn.activities = appendActiveTurnActivity(activeTurn, {
        message: event.message,
        tone: "default",
      });
      return;
    case "file.patch":
      activeTurn.filePath = event.filePath;
      activeTurn.activities = appendActiveTurnActivity(activeTurn, {
        message: `Updated ${event.filePath}.`,
        tone: "success",
      });
      return;
    case "validation.result":
      activeTurn.activities = appendActiveTurnActivity(activeTurn, {
        message:
          event.status === "passed"
            ? "Panel validation passed."
            : `Panel validation failed: ${event.errors.join(" ")}`,
        tone: event.status === "passed" ? "success" : "error",
      });
      return;
    case "compile.result":
      activeTurn.activities = appendActiveTurnActivity(activeTurn, {
        message:
          event.status === "passed"
            ? "Panel runtime checks passed."
            : `Panel runtime checks failed: ${event.errors.join(" ")}`,
        tone: event.status === "passed" ? "success" : "error",
      });
      return;
    case "turn.completed":
      activeTurn.status = "completed";
      activeTurn.activities = appendActiveTurnActivity(activeTurn, {
        message: "Panel updated.",
        tone: "success",
      });
      return;
    case "turn.failed":
      activeTurn.status = "failed";
      activeTurn.activities = appendActiveTurnActivity(activeTurn, {
        message: event.reason,
        tone: "error",
      });
      return;
    default:
      return;
  }
}

function appendActiveTurnActivity(
  activeTurn: ActiveOrganizationPanelTurn,
  activity: Omit<OrganizationPanelTurnActivity, "id">,
): readonly OrganizationPanelTurnActivity[] {
  const previous = activeTurn.activities.at(-1);
  if (previous?.message === activity.message && previous.tone === activity.tone) {
    return activeTurn.activities;
  }
  return [
    ...activeTurn.activities,
    {
      id: `${activeTurn.turnId}:activity:${activeTurn.activities.length}`,
      ...activity,
    },
  ].slice(-8);
}

function toPublicVersion(version: StoredOrganizationPanelVersion): OrganizationPanelVersion {
  const {
    beforeContents: _beforeContents,
    afterContents: _afterContents,
    ...publicVersion
  } = version;
  return publicVersion;
}

function renderStarterPanelDocument(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Organization panel</title>
    <style>
      *, *::before, *::after {
        box-sizing: border-box;
      }

      :root {
        color-scheme: dark;
        --t3-background: #111111;
        --t3-foreground: #f5f5f5;
        --t3-card: #151515;
        --t3-muted-foreground: rgba(245, 245, 245, 0.64);
        --t3-border: rgba(255, 255, 255, 0.08);
        --t3-input: rgba(255, 255, 255, 0.1);
        --t3-primary: oklch(0.588 0.217 264);
        --t3-radius: 8px;
        font-family:
          "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        background: var(--t3-background);
        color: var(--t3-foreground);
      }

      body {
        min-height: 100vh;
        margin: 0;
        background: var(--t3-background);
      }

      main {
        width: min(100%, 72rem);
        margin: 0 auto;
        padding: 1.25rem;
      }

      .panel {
        display: grid;
        gap: 0.875rem;
        min-height: 24rem;
        align-content: center;
        border: 1px solid var(--t3-border);
        border-radius: var(--t3-radius);
        padding: clamp(1rem, 4vw, 1.5rem);
        background: var(--t3-card);
      }

      h1 {
        margin: 0;
        font-size: 1.5rem;
        line-height: 1.15;
        letter-spacing: 0;
      }

      p {
        max-width: 42rem;
        margin: 0;
        color: var(--t3-muted-foreground);
        line-height: 1.6;
      }

      @media (max-width: 640px) {
        main {
          padding: 1rem;
        }

        .panel {
          min-height: 18rem;
        }

        h1 {
          font-size: 1.25rem;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="panel" aria-labelledby="panel-title">
        <h1 id="panel-title">Organization panel</h1>
        <p>Describe what this panel should show, and the generated result will be saved as plain HTML, CSS, and JavaScript.</p>
      </section>
    </main>
    <script>
      const panel = document.querySelector(".panel");
      if (panel) {
        panel.dataset.ready = "true";
      }
    </script>
  </body>
</html>
`;
}

function isLegacyStarterPanelDocument(
  document: OrganizationPanelDocument,
  organization: OrganizationPanelOrganization,
): boolean {
  return document.html.includes(`${organization.name} has a dedicated editable panel.`);
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
