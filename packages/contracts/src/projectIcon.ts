import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  ForwardCompatibleUnion,
  isUnknownUnionMember,
  TrimmedNonEmptyString,
  type UnknownUnionMember,
} from "./baseSchemas.ts";

export const ProjectIconColor = Schema.Literals([
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);
export type ProjectIconColor = typeof ProjectIconColor.Type;

const ProjectLucideIconName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);

const ProjectEmoji = TrimmedNonEmptyString.check(Schema.isMaxLength(32));

export const ProjectIconOverride = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("lucide"),
    name: ProjectLucideIconName,
    color: ProjectIconColor,
  }),
  Schema.Struct({
    kind: Schema.Literal("emoji"),
    emoji: ProjectEmoji,
  }),
]);
export type ProjectIconOverride = typeof ProjectIconOverride.Type;

/**
 * An icon as clients receive it. A kind from a newer server decodes as no
 * override, so the client shows the project's default icon. A known kind
 * whose payload does not decode still fails. Commands and stored events keep
 * the strict {@link ProjectIconOverride}.
 */
export const ReceivedProjectIcon = ForwardCompatibleUnion(ProjectIconOverride.members, "kind").pipe(
  Schema.decodeTo(
    Schema.NullOr(Schema.toType(ProjectIconOverride)),
    SchemaTransformation.transform<
      ProjectIconOverride | null,
      ProjectIconOverride | UnknownUnionMember<"kind">
    >({
      decode: (icon) => (isUnknownUnionMember(icon) ? null : icon),
      encode: (icon) => icon as ProjectIconOverride,
    }),
  ),
);
