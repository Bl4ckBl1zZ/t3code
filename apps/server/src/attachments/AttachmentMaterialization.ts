/**
 * AttachmentMaterialization - writes chat uploads into the workspace the agent
 * is running in, so a turn can hand the agent a path instead of a payload.
 *
 * The service's error channel is `never`, and that is the central design
 * decision. A turn must never die because a disk was full or a worktree was
 * read-only: every failure degrades to the previous behavior of inlining the
 * bytes, which makes this a strict superset of what shipped before.
 *
 * @module AttachmentMaterialization
 */
import type { ChatAttachment, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as WorkspacePathsModule from "../workspace/WorkspacePaths.ts";

import {
  UPLOADS_GITIGNORE_CONTENTS,
  UPLOADS_GITIGNORE_MARKER,
  UPLOADS_GITIGNORE_RELATIVE_PATH,
  UPLOADS_RELATIVE_DIR,
  appendUploadedFilesBlock,
  threadUploadsRelativeDir,
  uploadRelativePath,
  uploadedFilesPromptBlock,
} from "./uploadPaths.ts";

export type AttachmentDelivery = "workspace" | "inline" | "both";

/**
 * Hermes is the one provider whose gateway may run on another host — see
 * `HermesConnectionSecurity.ts`, which classifies endpoints as loopback or
 * remote. A file written into the server's worktree is invisible to a remote
 * agent, and Hermes already accepts every file type inline, so it loses nothing.
 */
const DRIVERS_WITH_LOCAL_FILESYSTEM_ACCESS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "cursor",
  "acp",
  "grok",
  "opencode",
]);

/**
 * The single place any of this is decided.
 *
 * Images resolve to `"both"`: the agent sees the screenshot immediately, and it
 * also gets a stable path it can cite in a later turn or hand to a tool instead
 * of asking for a re-upload. Image context cost is unchanged from before — it
 * was already inline. The savings come from the non-image files, which are the
 * ones that did not work at all.
 *
 * This is driver-level policy, deliberately not the same thing as an adapter's
 * runtime image capability: ACP negotiates image support per session, so an ACP
 * agent that did not negotiate images still gets `"both"` here, skips the inline
 * block inside the adapter, and falls back to the path in the prompt.
 */
export function resolveAttachmentDelivery(
  driver: ProviderDriverKind,
  attachment: ChatAttachment,
): AttachmentDelivery {
  if (!DRIVERS_WITH_LOCAL_FILESYSTEM_ACCESS.has(driver)) return "inline";
  // Preview annotation screenshots are UI plumbing. They belong in the model's
  // context, not in the user's project.
  if (attachment.role === "preview-annotation") return "inline";
  return attachment.type === "image" ? "both" : "workspace";
}

/**
 * Stamps each attachment with where it ended up, so the message bubble can show
 * the path and (only when a workspace write actually lost) a warning.
 *
 * Returns `null` when nothing changed — the common `"skipped"` case — so callers
 * can avoid emitting a pointless projection update.
 */
export function annotateAttachmentPlacement(
  attachments: ReadonlyArray<ChatAttachment>,
  result: AttachmentMaterializationResult,
): ReadonlyArray<ChatAttachment> | null {
  if (result.outcome === "skipped") return null;
  const byId = new Map(result.materialized.map((entry) => [entry.attachment.id, entry]));
  let changed = false;
  const annotated = attachments.map((attachment) => {
    const materialized = byId.get(attachment.id);
    if (materialized !== undefined) {
      if (attachment.workspacePath === materialized.relativePath) return attachment;
      changed = true;
      return {
        ...attachment,
        workspacePath: materialized.relativePath,
        materialization: "written" as const,
      };
    }
    // Left inline by policy rather than by failure: say nothing.
    if (resolveAttachmentDeliveryWasInlineOnly(attachment)) return attachment;
    if (attachment.materialization === "failed") return attachment;
    changed = true;
    return { ...attachment, materialization: "failed" as const };
  });
  return changed ? annotated : null;
}

function resolveAttachmentDeliveryWasInlineOnly(attachment: ChatAttachment): boolean {
  return attachment.role === "preview-annotation";
}

export interface MaterializedAttachment {
  readonly attachment: ChatAttachment;
  /** Workspace-relative, POSIX. This is what the prompt block shows the agent. */
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly status: "written" | "already-present";
}

export interface AttachmentMaterializationResult {
  readonly materialized: ReadonlyArray<MaterializedAttachment>;
  /** Ready to append to the turn text, or null when there is nothing to announce. */
  readonly promptBlock: string | null;
  /** What the adapter still sends inline: `"both"` images plus anything that degraded. */
  readonly inlineAttachments: ReadonlyArray<ChatAttachment>;
  /**
   * `"skipped"` means there was nothing to write (no workspace, or an
   * inline-only provider) and is the expected, silent path. `"failed"` means a
   * workspace existed and the write lost, and is worth showing the user.
   */
  readonly outcome: "written" | "skipped" | "failed";
}

export interface AttachmentMaterializationInput {
  readonly threadId: ThreadId;
  readonly driver: ProviderDriverKind;
  readonly cwd: string | null;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

export class AttachmentMaterialization extends Context.Service<
  AttachmentMaterialization,
  {
    readonly materialize: (
      input: AttachmentMaterializationInput,
    ) => Effect.Effect<AttachmentMaterializationResult>;
  }
>()("t3/attachments/AttachmentMaterialization") {}

const skipped = (attachments: ReadonlyArray<ChatAttachment>): AttachmentMaterializationResult => ({
  materialized: [],
  promptBlock: null,
  inlineAttachments: attachments,
  outcome: "skipped",
});

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePathsModule.WorkspacePaths;
  const config = yield* ServerConfig.ServerConfig;

  /**
   * Written before the first blob, on purpose: `GitVcsDriver` builds checkpoint
   * trees with `git add -A`, which honors gitignore. Writing a blob first would
   * bake it into that checkpoint.
   */
  const ensureUploadsIgnore = Effect.fn("AttachmentMaterialization.ensureUploadsIgnore")(function* (
    workspaceRoot: string,
  ) {
    const ignorePath = path.join(workspaceRoot, ...UPLOADS_GITIGNORE_RELATIVE_PATH.split("/"));
    const existing = yield* fileSystem
      .readFileString(ignorePath)
      .pipe(Effect.orElseSucceed(() => null));
    if (existing === null) {
      yield* fileSystem.writeFileString(ignorePath, UPLOADS_GITIGNORE_CONTENTS);
      return;
    }
    // A repo may have brought its own ignore file. Append once, keyed on the
    // marker, rather than appending on every turn.
    if (existing.split("\n").some((line: string) => line.trim() === "*")) return;
    if (existing.includes(UPLOADS_GITIGNORE_MARKER)) return;
    const separator = existing.endsWith("\n") ? "" : "\n";
    yield* fileSystem.writeFileString(
      ignorePath,
      `${existing}${separator}${UPLOADS_GITIGNORE_CONTENTS}`,
    );
  });

  const writeAttachment = Effect.fn("AttachmentMaterialization.writeAttachment")(function* (input: {
    readonly workspaceRoot: string;
    readonly threadId: ThreadId;
    readonly attachment: ChatAttachment;
  }) {
    const resolved = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.workspaceRoot,
      relativePath: uploadRelativePath({
        threadId: input.threadId,
        attachment: input.attachment,
      }),
    });

    // A resend, steer, restart, or session resume recomputes the same path, so
    // the common case is a stat rather than a re-read of a 20 MiB blob.
    const existing = yield* fileSystem
      .stat(resolved.absolutePath)
      .pipe(Effect.orElseSucceed(() => null));
    if (existing !== null && Number(existing.size) === input.attachment.sizeBytes) {
      return {
        attachment: input.attachment,
        relativePath: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        status: "already-present",
      } satisfies MaterializedAttachment;
    }

    const sourcePath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: input.attachment,
    });
    // The blob store is garbage collected independently, so a missing source is
    // an ordinary outcome rather than an error worth a failure channel.
    if (sourcePath === null) return null;
    const bytes = yield* fileSystem.readFile(sourcePath);

    const directory = path.dirname(resolved.absolutePath);
    yield* fileSystem.makeDirectory(directory, { recursive: true });

    // Publish atomically so a concurrent turn in the same worktree never sees a
    // half-written file. The temp name is per-attachment, so two turns writing
    // different attachments cannot clash on it either.
    const temporaryPath = path.join(directory, `.${path.basename(resolved.absolutePath)}.partial`);
    yield* fileSystem.writeFile(temporaryPath, bytes);
    yield* fileSystem.rename(temporaryPath, resolved.absolutePath);
    return {
      attachment: input.attachment,
      relativePath: resolved.relativePath,
      absolutePath: resolved.absolutePath,
      status: "written",
    } satisfies MaterializedAttachment;
  });

  const materialize = Effect.fn("AttachmentMaterialization.materialize")(function* (
    input: AttachmentMaterializationInput,
  ) {
    if (input.attachments.length === 0) return skipped([]);

    const inline: Array<ChatAttachment> = [];
    const diskBound: Array<ChatAttachment> = [];
    const alsoInline = new Set<string>();
    for (const attachment of input.attachments) {
      const delivery = resolveAttachmentDelivery(input.driver, attachment);
      if (delivery === "inline") {
        inline.push(attachment);
        continue;
      }
      diskBound.push(attachment);
      if (delivery === "both") {
        inline.push(attachment);
        alsoInline.add(attachment.id);
      }
    }

    if (diskBound.length === 0) return skipped(inline);
    if (input.cwd === null) return skipped(input.attachments);

    // `.t3code` may exist as a file, the root may be gone, or the tree may be
    // read-only. Never create a workspace root, and never remove or rename what
    // the user put there: degrade instead.
    const workspaceRoot = yield* Effect.gen(function* () {
      const root = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd ?? "");
      yield* fileSystem.makeDirectory(path.join(root, ...UPLOADS_RELATIVE_DIR.split("/")), {
        recursive: true,
      });
      yield* ensureUploadsIgnore(root);
      return root;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Skipped attachment materialization: uploads are not writable.", {
          threadId: input.threadId,
          cwd: input.cwd,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (workspaceRoot === null) {
      return { ...skipped(input.attachments), outcome: "failed" as const };
    }

    const results = yield* Effect.forEach(
      diskBound,
      (attachment) =>
        writeAttachment({ workspaceRoot, threadId: input.threadId, attachment }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not materialize attachment; falling back to inline.", {
              threadId: input.threadId,
              attachmentId: attachment.id,
              cause,
            }).pipe(Effect.as(null)),
          ),
        ),
      { concurrency: 2 },
    );

    const materialized: Array<MaterializedAttachment> = [];
    const inlineAttachments = [...inline];
    results.forEach((result, index) => {
      if (result !== null) {
        materialized.push(result);
        return;
      }
      const attachment = diskBound[index];
      // A `"both"` image is already queued for inline delivery; a failed write
      // costs it only the prompt-block line, so do not add it twice.
      if (attachment !== undefined && !alsoInline.has(attachment.id)) {
        inlineAttachments.push(attachment);
      }
    });

    return {
      materialized,
      promptBlock: uploadedFilesPromptBlock(
        materialized.map((entry) => ({
          relativePath: entry.relativePath,
          name: entry.attachment.name,
          mimeType: entry.attachment.mimeType,
          sizeBytes: entry.attachment.sizeBytes,
          alsoInline: alsoInline.has(entry.attachment.id),
        })),
      ),
      inlineAttachments,
      // Per-attachment success is carried on each `MaterializedAttachment`; this
      // is the thread-level signal the UI uses to decide whether to warn.
      outcome: materialized.length === 0 ? ("failed" as const) : ("written" as const),
    };
  });

  return AttachmentMaterialization.of({ materialize });
});

export const layer: Layer.Layer<
  AttachmentMaterialization,
  never,
  | FileSystem.FileSystem
  | Path.Path
  | WorkspacePathsModule.WorkspacePaths
  | ServerConfig.ServerConfig
> = Layer.effect(AttachmentMaterialization, make);

export { appendUploadedFilesBlock, threadUploadsRelativeDir };
