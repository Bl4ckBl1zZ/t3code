import { describe, expect, it } from "@effect/vitest";

import {
  buildTurnDiffTree,
  shouldAutoExpandChangedFiles,
  summarizeTurnDiffStats,
} from "./turnDiffTree";

describe("summarizeTurnDiffStats", () => {
  it("sums additions and deletions across files", () => {
    const stat = summarizeTurnDiffStats([
      { path: "README.md", kind: "modified", additions: 3, deletions: 1 },
      { path: "src/index.ts", kind: "modified", additions: 5, deletions: 2 },
    ]);

    expect(stat).toEqual({ additions: 8, deletions: 3 });
  });
});

describe("buildTurnDiffTree", () => {
  it("builds nested directory nodes with aggregated stats", () => {
    const tree = buildTurnDiffTree([
      { path: "src/index.ts", kind: "modified", additions: 2, deletions: 1 },
      { path: "src/components/Button.tsx", kind: "modified", additions: 4, deletions: 2 },
      { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "src",
        path: "src",
        stat: { additions: 6, deletions: 3 },
        children: [
          {
            kind: "directory",
            name: "components",
            path: "src/components",
            stat: { additions: 4, deletions: 2 },
            children: [
              {
                kind: "file",
                name: "Button.tsx",
                path: "src/components/Button.tsx",
                stat: { additions: 4, deletions: 2 },
              },
            ],
          },
          {
            kind: "file",
            name: "index.ts",
            path: "src/index.ts",
            stat: { additions: 2, deletions: 1 },
          },
        ],
      },
      {
        kind: "file",
        name: "README.md",
        path: "README.md",
        stat: { additions: 1, deletions: 0 },
      },
    ]);
  });

  it("compacts single-directory chains and stops at branch points", () => {
    const tree = buildTurnDiffTree([
      { path: "apps/server/src/index.ts", kind: "modified", additions: 2, deletions: 1 },
      { path: "apps/server/main.ts", kind: "modified", additions: 4, deletions: 0 },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "apps/server",
        path: "apps/server",
        stat: { additions: 6, deletions: 1 },
        children: [
          {
            kind: "directory",
            name: "src",
            path: "apps/server/src",
            stat: { additions: 2, deletions: 1 },
            children: [
              {
                kind: "file",
                name: "index.ts",
                path: "apps/server/src/index.ts",
                stat: { additions: 2, deletions: 1 },
              },
            ],
          },
          {
            kind: "file",
            name: "main.ts",
            path: "apps/server/main.ts",
            stat: { additions: 4, deletions: 0 },
          },
        ],
      },
    ]);
  });
});

describe("shouldAutoExpandChangedFiles", () => {
  const smallDiff = [{ path: "src/index.ts", kind: "modified", additions: 5, deletions: 2 }];

  it("expands only the latest turn", () => {
    expect(shouldAutoExpandChangedFiles(smallDiff, true)).toBe(true);
    expect(shouldAutoExpandChangedFiles(smallDiff, false)).toBe(false);
  });

  it("keeps large diffs collapsed", () => {
    const manyFiles = Array.from({ length: 6 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      kind: "modified",
      additions: 1,
      deletions: 0,
    }));
    expect(shouldAutoExpandChangedFiles(manyFiles, true)).toBe(false);

    const longDiff = [{ path: "src/index.ts", kind: "modified", additions: 300, deletions: 0 }];
    expect(shouldAutoExpandChangedFiles(longDiff, true)).toBe(false);
  });
});
