/**
 * projectFileSchemaUrl - resolves where this install tells editors and agents
 * to find the `t3.json` JSON Schema.
 *
 * The relay publishes the document built from its own contracts
 * (`/schema/t3.json`), so deriving the URL from the relay this install talks to
 * keeps the schema and the fields it describes on the same version. An explicit
 * `T3CODE_PROJECT_FILE_SCHEMA_URL` wins, for deployments serving the document
 * somewhere else.
 *
 * Synchronous and env-based rather than an Effect config: the agent
 * instructions that quote this URL are assembled as plain strings at module
 * load, and the value is deployment identity that cannot change under a
 * running process.
 *
 * @module projectFileSchemaUrl
 */
import { T3_PROJECT_FILE_SCHEMA_URL_ENV_VAR, t3ProjectFileSchemaUrl } from "@t3tools/contracts";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";

import { buildTimeRelayUrl } from "../cloud/publicConfig.ts";

/**
 * The schema URL to advertise, or null when this install has no relay and no
 * override — a local-only setup that publishes no schema.
 */
export function resolveProjectFileSchemaUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const override = env[T3_PROJECT_FILE_SCHEMA_URL_ENV_VAR]?.trim();
  if (override) return override;
  const relayUrl = normalizeSecureRelayUrl(env.T3CODE_RELAY_URL ?? "") ?? buildTimeRelayUrl;
  return relayUrl ? t3ProjectFileSchemaUrl(relayUrl) : null;
}
