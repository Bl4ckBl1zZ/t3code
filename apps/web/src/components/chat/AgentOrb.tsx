import type { CSSProperties } from "react";
import { agentHue } from "@t3tools/shared/agentIdentity";

import { cn } from "../../lib/utils";

/**
 * active — work in flight, the texture drifts. idle — vivid but still (e.g.
 * agent identity on a settled message). done — still and desaturated. failed —
 * red.
 */
export type AgentOrbState = "active" | "idle" | "done" | "failed";

/**
 * Iridescent orb textures. One per agent, picked by the same hash that drives
 * the hue, so an agent keeps one face across the timeline, messages, and
 * panels. Each is a small (2-6 KB) webp; the whole set is well under 100 KB and
 * loads once per session.
 */
const AGENT_ORB_TEXTURES = [
  "plume",
  "islands",
  "ribbon",
  "vortex",
  "cells",
  "fan",
  "contours",
  "eclipse",
  "petals",
  "prism",
] as const;

/**
 * Per-texture crop. The source art is a full scene; these offsets frame the
 * part that reads best once it is masked down to a ~16px circle.
 */
const AGENT_ORB_CROPS = [
  "50% 66%",
  "34% 28%",
  "68% 56%",
  "46% 44%",
  "76% 30%",
  "28% 72%",
  "58% 78%",
  "38% 54%",
  "50% 50%",
  "52% 52%",
] as const;

export function agentOrbHue(seed: string, state: AgentOrbState = "idle"): number {
  return state === "failed" ? 0 : agentHue(seed);
}

export function agentOrbTextureIndex(seed: string): number {
  return agentHue(seed) % AGENT_ORB_TEXTURES.length;
}

export function AgentOrb(props: {
  readonly seed: string;
  readonly size?: number;
  readonly state?: AgentOrbState;
  readonly className?: string;
}) {
  const state = props.state ?? "active";
  const size = props.size ?? 20;
  const textureIndex = agentOrbTextureIndex(props.seed);
  return (
    <span
      aria-hidden="true"
      data-agent-orb-state={state}
      data-agent-orb-texture={textureIndex}
      className={cn("agent-orb relative shrink-0 overflow-hidden rounded-full", props.className)}
      style={
        {
          width: size,
          height: size,
          "--agent-orb-h": String(agentOrbHue(props.seed, state)),
        } as CSSProperties
      }
    >
      <img
        alt=""
        className="agent-orb-texture"
        decoding="async"
        draggable={false}
        loading="lazy"
        src={`/agent-orbs/${AGENT_ORB_TEXTURES[textureIndex]}.webp`}
        style={{ objectPosition: AGENT_ORB_CROPS[textureIndex] }}
      />
    </span>
  );
}
