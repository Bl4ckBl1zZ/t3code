import { describe, expect, it } from "vite-plus/test";
import type { PullRequestStack } from "@t3tools/contracts";
import { reviewStackAction } from "./pullRequestStackReview";
const stack: PullRequestStack = {
  id: "stack",
  number: 8,
  url: "https://github.com/a/b/stack/8",
  base: "main",
  layers: [
    { number: 1, headBranch: "one", headSha: "aaa", state: "merged" },
    { number: 2, headBranch: "two", headSha: "bbb", state: "open" },
    { number: 3, headBranch: "three", headSha: "ccc", state: "open" },
  ],
};
describe("reviewed stack operations", () => {
  it("merges only the selected prefix's unmerged revisions", () => {
    expect(reviewStackAction(stack, 2, "merge")?.heads).toEqual([{ number: 2, headSha: "bbb" }]);
  });
  it("rebases every unmerged revision from the top", () => {
    expect(reviewStackAction(stack, 2, "update-branch")).toBeNull();
    expect(reviewStackAction(stack, 3, "update-branch")?.heads).toEqual([
      { number: 2, headSha: "bbb" },
      { number: 3, headSha: "ccc" },
    ]);
  });
  it("refuses closed, draft, unknown and missing revisions", () => {
    expect(reviewStackAction(stack, 9, "merge")).toBeNull();
    expect(reviewStackAction(stack, 1, "merge")).toBeNull();
    for (const change of [
      { state: "closed" as const },
      { isDraft: true },
      { headSha: undefined },
    ]) {
      const changed = {
        ...stack,
        layers: stack.layers.map((layer) => (layer.number === 2 ? { ...layer, ...change } : layer)),
      };
      expect(reviewStackAction(changed, 3, "merge")).toBeNull();
    }
  });
  it("does not include unrelated later layers in the reviewed prefix", () => {
    const changed = {
      ...stack,
      layers: stack.layers.map((layer) =>
        layer.number === 3 ? { ...layer, state: "closed" as const } : layer,
      ),
    };
    expect(reviewStackAction(changed, 2, "merge")?.heads).toEqual([{ number: 2, headSha: "bbb" }]);
  });
});
