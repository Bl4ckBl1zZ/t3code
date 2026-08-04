import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import {
  inferExtensionFromMimeType,
  inferMimeTypeFromFileName,
  validateComposerAttachment,
} from "@t3tools/shared/composerAttachments";
import * as Schema from "effect/Schema";
import type { ResolvedSharePayload, SharePayload } from "expo-sharing";

import { DraftComposerAttachmentSchema } from "../../lib/composer-image-schema";
import type { DraftComposerAttachment } from "../../lib/composerAttachmentKinds";
import { estimateBase64ByteSize } from "../../lib/base64";

export interface IncomingShareDraft {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly destination?: IncomingShareDestination;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly warnings: ReadonlyArray<string>;
}

export interface IncomingShareDestination {
  readonly environmentId: string;
  readonly projectId: string;
}

const IncomingShareDestinationSchema = Schema.Struct({
  environmentId: Schema.String,
  projectId: Schema.String,
});

export const IncomingShareDraftSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String,
  createdAt: Schema.String,
  destination: Schema.optional(IncomingShareDestinationSchema),
  text: Schema.String,
  attachments: Schema.Array(DraftComposerAttachmentSchema),
  warnings: Schema.Array(Schema.String),
});

const decodeIncomingShareDraftSync = Schema.decodeUnknownSync(IncomingShareDraftSchema);

export function decodeIncomingShareDraft(value: unknown): IncomingShareDraft {
  return decodeIncomingShareDraftSync(value);
}

export interface IncomingShareFileReader {
  readonly readBase64: (uri: string) => Promise<string>;
  readonly removeOwnedFile: (uri: string) => Promise<void> | void;
}

function sharedText(payloads: ReadonlyArray<SharePayload>): string {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const payload of payloads) {
    if (payload.shareType !== "text" && payload.shareType !== "url") {
      continue;
    }
    const value = payload.value.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
  }
  return values.join("\n\n");
}

function resolvedImageFor(
  payload: SharePayload,
  index: number,
  resolvedPayloads: ReadonlyArray<ResolvedSharePayload>,
  consumedIndexes: Set<number>,
): ResolvedSharePayload | undefined {
  const sameIndex = resolvedPayloads[index];
  if (
    !consumedIndexes.has(index) &&
    sameIndex?.shareType === payload.shareType &&
    sameIndex.value === payload.value
  ) {
    consumedIndexes.add(index);
    return sameIndex;
  }
  const matchingIndex = resolvedPayloads.findIndex(
    (candidate, candidateIndex) =>
      !consumedIndexes.has(candidateIndex) &&
      candidate.shareType === payload.shareType &&
      candidate.value === payload.value,
  );
  if (matchingIndex < 0) {
    return undefined;
  }
  consumedIndexes.add(matchingIndex);
  return resolvedPayloads[matchingIndex];
}

async function releaseOwnedFiles(
  fileReader: IncomingShareFileReader,
  uris: ReadonlyArray<string | undefined>,
): Promise<void> {
  for (const uri of new Set(uris.filter((candidate): candidate is string => Boolean(candidate)))) {
    try {
      await fileReader.removeOwnedFile(uri);
    } catch {
      // Temporary-file cleanup is best-effort and must never discard content
      // that was successfully converted into a durable composer attachment.
    }
  }
}

/** Share types that become attachments rather than message text. */
const SHAREABLE_ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  "image",
  "video",
  "audio",
  "file",
]);

function fallbackName(uri: string, index: number, payload: SharePayload): string {
  try {
    const pathName = new URL(uri).pathname.split("/").findLast((segment) => segment.length > 0);
    if (pathName) {
      return decodeURIComponent(pathName);
    }
  } catch {
    // Fall through to a deterministic attachment name.
  }
  const mimeType = payload.mimeType ?? "";
  const extension = inferExtensionFromMimeType(mimeType) ?? "";
  return `shared-${payload.shareType}-${index + 1}${extension}`;
}

export async function buildIncomingShareDraft(input: {
  readonly payloads: ReadonlyArray<SharePayload>;
  readonly resolvedPayloads: ReadonlyArray<ResolvedSharePayload>;
  readonly fileReader: IncomingShareFileReader;
  readonly id: string;
  readonly createdAt: string;
}): Promise<IncomingShareDraft> {
  const attachments: DraftComposerAttachment[] = [];
  const warnings: string[] = [];
  const consumedResolvedPayloadIndexes = new Set<number>();
  let warnedAttachmentLimit = false;

  for (const [index, payload] of input.payloads.entries()) {
    // Text and URLs become the draft's message body; everything else is a file
    // the agent can open once it is materialized into the project.
    if (!SHAREABLE_ATTACHMENT_TYPES.has(payload.shareType)) {
      continue;
    }
    const resolved = resolvedImageFor(
      payload,
      index,
      input.resolvedPayloads,
      consumedResolvedPayloadIndexes,
    );
    const uri = resolved?.contentUri ?? payload.value;
    if (attachments.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      if (!warnedAttachmentLimit) {
        warnings.push(
          `Only the first ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} shared files were attached.`,
        );
        warnedAttachmentLimit = true;
      }
      await releaseOwnedFiles(input.fileReader, [uri, payload.value]);
      continue;
    }

    const name = resolved?.originalName ?? fallbackName(uri, index, payload);
    const mimeType = (
      resolved?.contentMimeType ??
      payload.mimeType ??
      inferMimeTypeFromFileName(name) ??
      "application/octet-stream"
    ).toLowerCase();
    if (!uri) {
      warnings.push(`Could not read '${name}'.`);
      await releaseOwnedFiles(input.fileReader, [uri, payload.value]);
      continue;
    }
    const declaredSize = resolved?.contentSize ?? null;
    if (declaredSize !== null) {
      const preflight = validateComposerAttachment({ name, sizeBytes: declaredSize, mimeType });
      if (!preflight.accepted) {
        // Reject before reading: no reason to pull 30 MB into memory first.
        warnings.push(preflight.message);
        await releaseOwnedFiles(input.fileReader, [uri, payload.value]);
        continue;
      }
    }

    try {
      const base64 = await input.fileReader.readBase64(uri);
      const sizeBytes = declaredSize ?? estimateBase64ByteSize(base64);
      const validation = validateComposerAttachment({ name, sizeBytes, mimeType });
      if (!validation.accepted) {
        warnings.push(validation.message);
        continue;
      }
      const dataUrl = `data:${validation.mimeType};base64,${base64}`;
      attachments.push({
        id: `${input.id}:${validation.type}:${index}`,
        ...(validation.type === "image"
          ? {
              type: "image" as const,
              // The share provider's file is temporary. A data-backed preview
              // keeps the composer valid after its source file and App Group
              // entry are gone.
              previewUri: dataUrl,
            }
          : { type: validation.type }),
        name: validation.name,
        mimeType: validation.mimeType,
        sizeBytes,
        dataUrl,
      });
    } catch {
      warnings.push(`Could not read '${name}'.`);
    } finally {
      await releaseOwnedFiles(input.fileReader, [uri, payload.value]);
    }
  }

  return {
    schemaVersion: 1,
    id: input.id,
    createdAt: input.createdAt,
    text: sharedText(input.payloads),
    attachments,
    warnings,
  };
}

export function hasIncomingShareContent(draft: IncomingShareDraft): boolean {
  return draft.text.trim().length > 0 || draft.attachments.length > 0;
}
