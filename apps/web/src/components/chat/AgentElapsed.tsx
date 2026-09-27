import { useEffect, useRef } from "react";

export interface AgentElapsedTiming {
  readonly status: string;
  /** ISO timestamps. */
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function elapsedBetween(startedAt: string, endIso: string | null): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "";
  }
  return formatElapsedSeconds((end - start) / 1000);
}

function isLive(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

/**
 * Elapsed time for the current activation. Live agents self-tick via DOM
 * writes (zero React commits per tick); settled agents freeze at completedAt.
 * A settled agent without a completion time shows nothing rather than counting
 * the row's age as work.
 */
export function AgentElapsed({ agent }: { agent: AgentElapsedTiming }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = isLive(agent.status);
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) {
      return;
    }
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = elapsedBetween(startedAt, null);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);

  if (!startedAt || (!live && agent.completedAt === null)) {
    return null;
  }
  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(startedAt, live ? null : agent.completedAt)}
    </span>
  );
}
