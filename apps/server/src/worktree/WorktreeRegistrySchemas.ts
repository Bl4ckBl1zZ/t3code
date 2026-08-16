import * as Schema from "effect/Schema";

export const WorktreeRetentionRegistryOwnership = Schema.Literals([
  "t3-created",
  "legacy-discovered",
  "unmanaged",
]);
export type WorktreeRetentionRegistryOwnership = typeof WorktreeRetentionRegistryOwnership.Type;

export const WorktreeRetentionRegistryState = Schema.Literals(["present", "removed"]);
export type WorktreeRetentionRegistryState = typeof WorktreeRetentionRegistryState.Type;

export const WorktreeThreadPathLookup = Schema.Struct({
  threadId: Schema.String,
  worktreePath: Schema.String,
});
export type WorktreeThreadPathLookup = typeof WorktreeThreadPathLookup.Type;
