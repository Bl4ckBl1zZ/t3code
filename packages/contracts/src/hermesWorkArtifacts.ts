import * as Schema from "effect/Schema";

export const HermesWorkArtifact = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["image", "file", "link"]),
  value: Schema.String,
  label: Schema.String,
  sessionId: Schema.String,
  profile: Schema.String,
  sessionTitle: Schema.String,
  timestamp: Schema.Number,
});
export type HermesWorkArtifact = typeof HermesWorkArtifact.Type;
