// Deterministic per-agent color identity. Hashing the stable id (subagentId /
// child thread id) keeps an agent the same hue across the timeline card, chat
// messages, and the relationships panel — and across web and mobile.
export function agentHue(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return ((hash % 360) + 360) % 360;
}
