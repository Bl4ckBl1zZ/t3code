import type { PullRequestStack, PullRequestStackHead } from "@t3tools/contracts";

/** Capture only the affected unmerged revisions, matching the server's atomic review check. */
export function reviewStackAction(
  stack: PullRequestStack,
  number: number,
  action: "merge" | "update-branch",
) {
  const index = stack.layers.findIndex((layer) => layer.number === number);
  if (index < 0 || (action === "update-branch" && index !== stack.layers.length - 1)) return null;
  const layers = (action === "merge" ? stack.layers.slice(0, index + 1) : stack.layers).filter(
    (layer) => layer.state !== "merged",
  );
  if (
    !layers.length ||
    layers.some(
      (layer) => layer.state !== "open" || !layer.headSha || (action === "merge" && layer.isDraft),
    )
  )
    return null;
  const heads: PullRequestStackHead[] = layers.map((layer) => ({
    number: layer.number,
    headSha: layer.headSha!,
  }));
  return { stackNumber: stack.number, number, action, layers, heads };
}
