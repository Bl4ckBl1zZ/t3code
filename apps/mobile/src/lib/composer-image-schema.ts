import * as Schema from "effect/Schema";

/**
 * Persisted composer drafts. The image variant is unchanged so drafts written
 * by older builds still decode; documents were added alongside it rather than
 * by widening the image struct.
 */
export const DraftComposerImageAttachmentSchema = Schema.Struct({
  id: Schema.String,
  previewUri: Schema.String,
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});

export const DraftComposerDocumentAttachmentSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["file", "pdf", "video"]),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});

export const DraftComposerAttachmentSchema = Schema.Union([
  DraftComposerImageAttachmentSchema,
  DraftComposerDocumentAttachmentSchema,
]);
