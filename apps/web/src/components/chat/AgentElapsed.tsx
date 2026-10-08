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

/** Short form for tight rows: "45s", "12m", "1.5h", "14h". Rounds down. */
export function formatCompactElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  if (minutes >= 600) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 6) / 10}h`;
}

function elapsedBetween(
  startedAt: string,
  endIso: string | null,
  format: (totalSeconds: number) => string,
): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "";
  }
  return format((end - start) / 1000);
}

function isLive(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

/** Whether `AgentElapsed` has a time to show: started, and either live or completed. */
export function hasAgentElapsed(agent: AgentElapsedTiming): boolean {
  return agent.startedAt !== null && (isLive(agent.status) || agent.completedAt !== null);
}

/**
 * Elapsed time for the current activation. Live agents self-tick via DOM
 * writes (zero React commits per tick); settled agents freeze at completedAt.
 * A settled agent without a completion time shows nothing rather than counting
 * the row's age as work. `compact` drops the smaller unit for narrow rows such
 * as Lineage.
 */
export function AgentElapsed({
  agent,
  compact = false,
}: {
  agent: AgentElapsedTiming;
  compact?: boolean;
}) {
  const format = compact ? formatCompactElapsedSeconds : formatElapsedSeconds;
  const textRef = useRef<HTMLSpanElement>(null);
  const live = isLive(agent.status);
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) {
      return;
    }
    const update = () => {
      if (textRef.current) {
        const text = elapsedBetween(startedAt, null, format);
        if (textRef.current.textContent !== text) textRef.current.textContent = text;
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt, format]);

  if (!startedAt || !hasAgentElapsed(agent)) {
    return null;
  }
  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(startedAt, live ? null : agent.completedAt, format)}
    </span>
  );
}
