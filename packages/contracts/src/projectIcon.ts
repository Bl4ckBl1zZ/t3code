import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

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
