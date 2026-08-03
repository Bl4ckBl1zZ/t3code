import type { CSSProperties } from "react";
import { agentHue } from "@t3tools/shared/agentIdentity";

import { cn } from "../../lib/utils";

/**
 * active — work in flight, smoke drifts. idle — vivid but still (e.g. agent
 * identity on a settled message). done — still and desaturated. failed — red.
 */
export type AgentOrbState = "active" | "idle" | "done" | "failed";

export function agentOrbHue(seed: string, state: AgentOrbState = "idle"): number {
  return state === "failed" ? 0 : agentHue(seed);
}

export function AgentOrb(props: {
  readonly seed: string;
  readonly size?: number;
  readonly state?: AgentOrbState;
  readonly className?: string;
}) {
  const state = props.state ?? "active";
  const size = props.size ?? 20;
  return (
    <span
      aria-hidden="true"
      data-agent-orb-state={state}
      className={cn("agent-orb relative shrink-0 overflow-hidden rounded-full", props.className)}
      style={
        {
          width: size,
          height: size,
          "--agent-orb-h": String(agentOrbHue(props.seed, state)),
        } as CSSProperties
      }
    />
  );
}
