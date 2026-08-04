import type { APIRoute } from "astro";

import {
  buildT3ProjectFileJsonSchema,
  T3_PROJECT_FILE_SCHEMA_URL_ENV_VAR,
} from "@t3tools/shared/t3ProjectFile";

// A build-time copy of the same document the relay serves at /schema/t3.json,
// for deployments that publish the schema from this site instead. `$schema`
// references point at the relay by default, so this route is only canonical
// when T3CODE_PROJECT_FILE_SCHEMA_URL names this site — without it the document
// omits `$id` and simply describes itself from wherever it was fetched.
const schemaId = process.env[T3_PROJECT_FILE_SCHEMA_URL_ENV_VAR]?.trim() || undefined;

export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildT3ProjectFileJsonSchema({ id: schemaId }), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
