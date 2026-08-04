import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ProjectScriptIcon } from "./project.ts";

/** File name of the checked-in T3 project file, resolved at the workspace root. */
export const T3_PROJECT_FILE_NAME = "t3.json";

/**
 * Path the relay serves the {@link T3ProjectFile} JSON Schema at.
 *
 * The relay is the only host every deployment already has, which is why the
 * schema rides along with it rather than on a marketing domain: no extra DNS,
 * no extra deploy, and a personal stage serves its own build's document
 * instead of borrowing production's.
 */
export const T3_PROJECT_FILE_SCHEMA_PATH = "/schema/t3.json";

/**
 * URL of the schema published by the relay at `relayUrl`, or null when that is
 * not a usable absolute URL.
 *
 * Deriving it rather than hardcoding a host keeps the document and the fields
 * it describes on the same deployment. That matters because the schema forbids
 * additional properties: validating against a build that lacks a field this
 * one has turns that field into an editor error.
 */
export function t3ProjectFileSchemaUrl(relayUrl: string): string | null {
  try {
    return new URL(T3_PROJECT_FILE_SCHEMA_PATH, relayUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Environment variable overriding the derived schema URL, for deployments that
 * publish the document somewhere other than their own relay (an internal
 * mirror, a pinned older revision).
 */
export const T3_PROJECT_FILE_SCHEMA_URL_ENV_VAR = "T3CODE_PROJECT_FILE_SCHEMA_URL";

const T3_PROJECT_FILE_PATH_MAX_LENGTH = 512;
const T3_PROJECT_FILE_URL_MAX_LENGTH = 2048;
const T3_PROJECT_FILE_MAX_SCRIPTS = 50;

// Annotations go on the encoded (string) side so they survive into the
// published JSON Schema; decoding still trims and re-validates non-emptiness.
const trimmedNonEmpty = (annotations: { readonly description: string }, maxLength?: number) => {
  const annotated = Schema.String.annotate(annotations);
  const encoded =
    maxLength === undefined
      ? annotated.check(Schema.isNonEmpty())
      : annotated.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
};

export const T3ProjectFileScript = Schema.Struct({
  name: trimmedNonEmpty({
    description: "Display name for the script, shown in the T3 Code scripts menu.",
  }),
  command: trimmedNonEmpty({
    description: "Shell command executed in a T3 Code terminal at the project root.",
  }),
  icon: Schema.optionalKey(
    ProjectScriptIcon.annotate({
      description: 'Icon shown next to the script in the scripts menu. Defaults to "play".',
    }),
  ),
  runOnWorktreeCreate: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs automatically after a worktree is created for a new thread.",
    }),
  ),
  runOnWorktreeDelete: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs automatically in the worktree right before it is removed.",
    }),
  ),
  previewUrl: Schema.optionalKey(
    trimmedNonEmpty({
      description:
        "URL opened in the in-app browser preview when this script runs. Only honored on the desktop build.",
    }),
  ),
  autoOpenPreview: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, automatically open the preview panel at `previewUrl` the moment the script starts.",
    }),
  ),
  singleRun: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, at most one run of this script can be active at a time; launching it again while running stops the active run instead.",
    }),
  ),
}).annotate({
  description: "A project script that team members can import into T3 Code.",
});
export type T3ProjectFileScript = typeof T3ProjectFileScript.Type;

export const T3ProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: `URL of the JSON Schema for this file, served by your T3 Code relay at "${T3_PROJECT_FILE_SCHEMA_PATH}".`,
    }),
  ),
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before T3 Code\'s built-in icon locations.',
      },
      T3_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  previewUrl: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          "The project's dev-server URL (e.g. \"http://localhost:5173\"). Always listed in the thread's Ports section, even before anything is listening, so it is one click away from the moment a thread opens. Must be a loopback address.",
      },
      T3_PROJECT_FILE_URL_MAX_LENGTH,
    ),
  ),
  scripts: Schema.optionalKey(
    Schema.Array(T3ProjectFileScript)
      .annotate({
        description: "Project scripts shared with everyone who opens this repository in T3 Code.",
      })
      .check(Schema.isMaxLength(T3_PROJECT_FILE_MAX_SCRIPTS)),
  ),
}).annotate({
  title: "T3 project file",
  description: "Checked-in project configuration for T3 Code (t3.json at the repository root).",
});
export type T3ProjectFile = typeof T3ProjectFile.Type;
