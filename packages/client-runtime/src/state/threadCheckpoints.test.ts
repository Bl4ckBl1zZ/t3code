import type { CheckpointScopeId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filesChangedAfterCheckpoint } from "./threadCheckpoints.ts";

const scope = (id: string) => id as CheckpointScopeId;
const checkpoint = (turnCount: number, paths: string[], scopeId = scope("main")) => ({
  scopeId,
  checkpointTurnCount: turnCount,
  files: paths.map((path) => ({ path, kind: "modified", additions: 1, deletions: 0 })),
});

describe("filesChangedAfterCheckpoint", () => {
  it("lists every file later turns changed, once, in first-change order", () => {
    expect(
      filesChangedAfterCheckpoint(
        [
          checkpoint(3, ["b.ts", "c.ts"]),
          checkpoint(1, ["kept.ts"]),
          checkpoint(2, ["a.ts", "b.ts"]),
        ],
        1,
      ),
    ).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("ignores checkpoints from another workspace scope", () => {
    expect(
      filesChangedAfterCheckpoint(
        [
          checkpoint(1, []),
          checkpoint(2, ["a.ts"]),
          checkpoint(3, ["other.ts"], scope("worktree")),
        ],
        1,
      ),
    ).toEqual(["a.ts"]);
  });

  it("counts every checkpoint when restoring before the first turn", () => {
    expect(
      filesChangedAfterCheckpoint([checkpoint(1, ["a.ts"]), checkpoint(2, ["b.ts"])], 0),
    ).toEqual(["a.ts", "b.ts"]);
  });

  it("is empty when nothing changed afterwards", () => {
    expect(filesChangedAfterCheckpoint([checkpoint(1, ["a.ts"])], 1)).toEqual([]);
  });
});
