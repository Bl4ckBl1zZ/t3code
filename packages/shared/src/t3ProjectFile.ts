import * as Schema from "effect/Schema";

import { T3ProjectFile } from "@t3tools/contracts";

import { fromLenientJson } from "./schemaJson.ts";

// Re-exported for consumers that depend on shared but not on contracts.
export {
  T3_PROJECT_FILE_SCHEMA_PATH,
  T3_PROJECT_FILE_SCHEMA_URL_ENV_VAR,
  t3ProjectFileSchemaUrl,
} from "@t3tools/contracts";

/**
 * Codec between the raw `t3.json` file contents (lenient JSONC string) and the
 * decoded {@link T3ProjectFile}.
 */
export const T3ProjectFileFromJson = fromLenientJson(T3ProjectFile);

/**
 * Build the publishable JSON Schema document for `t3.json` (draft 2020-12),
 * so editors get LSP support via a `$schema` reference.
 *
 * `id` is the URL the caller serves the document at — the relay fills it from
 * the request it is answering, so every deployment stamps its own address
 * without being told what that is. Omitted when absent, which is valid: a
 * schema with no `$id` resolves against wherever it was fetched from.
 */
export function buildT3ProjectFileJsonSchema(options?: {
  readonly id?: string | null | undefined;
}): Record<string, unknown> {
  const id = options?.id ?? null;
  const document = Schema.toJsonSchemaDocument(T3ProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...(id ? { $id: id } : {}),
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
