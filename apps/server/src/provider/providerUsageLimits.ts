import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";

const SESSION_MINS = 300;
const WEEK_MINS = 10080;
const MONTH_MINS = 43200;
const clamp = (value: number) => Math.min(100, Math.max(0, value));
const iso = (value: string | number | null | undefined): string | undefined => {
  if (value == null) return undefined;
  const date = DateTime.make(value);
  return Option.isSome(date) ? DateTime.formatIso(date.value) : undefined;
};

export function unavailableUsageLimits(
  checkedAt: string,
  reason: "unsupported" | "probeFailed",
): ServerProviderUsageLimits {
  return { checkedAt, windows: [], unavailable: { reason } };
}

interface CodexWindow {
  readonly usedPercent: number;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
}
export interface CodexRateLimitSnapshot {
  readonly planType?: string | null;
  readonly primary?: CodexWindow | null;
  readonly secondary?: CodexWindow | null;
}

export function codexUsageLimits(
  snapshot: CodexRateLimitSnapshot,
  checkedAt: string,
): ServerProviderUsageLimits {
  const monthly = snapshot.planType === "free" || snapshot.planType === "go";
  const windows: ServerProviderUsageWindow[] = [];
  for (const [id, window, fallback] of [
    ["primary", snapshot.primary, monthly ? MONTH_MINS : SESSION_MINS],
    ["secondary", snapshot.secondary, WEEK_MINS],
  ] as const) {
    if (!window || !Number.isFinite(window.usedPercent)) continue;
    const duration = window.windowDurationMins;
    const windowDurationMins =
      typeof duration === "number" && Number.isInteger(duration) && duration > 0
        ? duration
        : fallback;
    const kind =
      windowDurationMins >= MONTH_MINS
        ? "monthly"
        : windowDurationMins >= WEEK_MINS
          ? "weekly"
          : "session";
    const resetsAt =
      typeof window.resetsAt === "number" && window.resetsAt > 0
        ? iso(window.resetsAt * 1000)
        : undefined;
    windows.push({
      id,
      kind,
      label: kind === "monthly" ? "Monthly" : kind === "weekly" ? "Weekly" : "Session",
      usedPercent: clamp(window.usedPercent),
      windowDurationMins,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return { checkedAt, windows };
}

export function claudeUsageLimits(
  response: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">,
  checkedAt: string,
): ServerProviderUsageLimits {
  if (!response.rate_limits_available || !response.rate_limits)
    return unavailableUsageLimits(checkedAt, "unsupported");
  const windows: ServerProviderUsageWindow[] = [];
  const append = (
    id: string,
    label: string,
    kind: "session" | "weekly",
    utilization: unknown,
    reset: string | null | undefined,
  ) => {
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) return;
    const resetsAt = iso(reset);
    windows.push({
      id,
      label,
      kind,
      usedPercent: clamp(utilization),
      windowDurationMins: kind === "weekly" ? WEEK_MINS : SESSION_MINS,
      ...(resetsAt ? { resetsAt } : {}),
    });
  };
  for (const [id, label, kind] of [
    ["five_hour", "Session", "session"],
    ["seven_day", "Weekly", "weekly"],
  ] as const) {
    const window = response.rate_limits[id];
    if (window) append(id, label, kind, window.utilization, window.resets_at);
  }
  const scoped = (response.rate_limits as { readonly model_scoped?: unknown }).model_scoped;
  if (Array.isArray(scoped)) {
    for (const raw of scoped as unknown[]) {
      if (
        !raw ||
        typeof raw !== "object" ||
        !("display_name" in raw) ||
        typeof raw.display_name !== "string" ||
        !raw.display_name.trim()
      )
        continue;
      const utilization = "utilization" in raw ? raw.utilization : undefined;
      const reset =
        "resets_at" in raw && typeof raw.resets_at === "string" ? raw.resets_at : undefined;
      append(
        `seven_day_${raw.display_name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
        `Weekly · ${raw.display_name}`,
        "weekly",
        utilization,
        reset,
      );
    }
  }
  return { checkedAt, windows };
}
