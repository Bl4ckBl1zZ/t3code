import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
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
  readonly limitId?: string | null;
  readonly planType?: string | null;
  readonly primary?: CodexWindow | null;
  readonly secondary?: CodexWindow | null;
}

export function codexUsageLimits(
  snapshot: CodexRateLimitSnapshot,
  checkedAt: string,
  resetCredits?: {
    readonly availableCount: number;
    readonly credits?:
      | readonly { readonly status: string; readonly expiresAt?: number | null }[]
      | null;
  } | null,
): ServerProviderUsageLimits {
  if (snapshot.limitId && snapshot.limitId !== "codex") return { checkedAt, windows: [] };
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
  const expiries =
    resetCredits?.credits?.flatMap((credit) =>
      credit.status === "available" &&
      typeof credit.expiresAt === "number" &&
      Number.isFinite(credit.expiresAt)
        ? [credit.expiresAt]
        : [],
    ) ?? [];
  const nextExpiresAt = expiries.length ? iso(Math.min(...expiries) * 1000) : undefined;
  return {
    checkedAt,
    windows,
    ...(resetCredits && Number.isFinite(resetCredits.availableCount)
      ? {
          resetCredits: {
            availableCount: Math.max(0, Math.floor(resetCredits.availableCount)),
            ...(nextExpiresAt ? { nextExpiresAt } : {}),
          },
        }
      : {}),
  };
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

/** A driver supplies this listener to its own V2 adapter; accounts never share it. */
export class ClaudeUsageLimitListener extends Context.Service<
  ClaudeUsageLimitListener,
  {
    readonly publish: (info: SDKRateLimitInfo) => Effect.Effect<void>;
  }
>()("t3/provider/providerUsageLimits/ClaudeUsageLimitListener") {}

/** Sparse live windows retain the probe's reset time and unrelated account windows. */
export function applyClaudeRateLimitEvent(
  previous: ServerProviderUsageLimits | undefined,
  info: SDKRateLimitInfo,
  checkedAt: string,
): ServerProviderUsageLimits | undefined {
  if (
    previous?.unavailable?.reason === "unsupported" ||
    typeof info.utilization !== "number" ||
    !Number.isFinite(info.utilization)
  )
    return previous;
  const type: string | undefined = info.rateLimitType;
  const scoped =
    type === "seven_day_overage_included"
      ? previous?.windows.find(
          (window) => window.id.startsWith("seven_day_") && window.kind === "weekly",
        )
      : undefined;
  const id = type === "five_hour" || type === "seven_day" ? type : scoped?.id;
  if (!id) return previous;
  const existing = previous?.windows.find((window) => window.id === id);
  const reset =
    typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt) && info.resetsAt > 0
      ? iso(info.resetsAt * 1000)
      : undefined;
  const kind = id === "five_hour" ? "session" : "weekly";
  const next: ServerProviderUsageWindow = {
    id,
    kind,
    label: scoped?.label ?? (kind === "session" ? "Session" : "Weekly"),
    windowDurationMins:
      existing?.windowDurationMins ?? (kind === "session" ? SESSION_MINS : WEEK_MINS),
    usedPercent: clamp(info.utilization * 100),
    ...((reset ?? existing?.resetsAt) ? { resetsAt: reset ?? existing?.resetsAt } : {}),
  };
  if (
    existing &&
    existing.usedPercent === next.usedPercent &&
    existing.resetsAt === next.resetsAt &&
    existing.label === next.label &&
    !previous?.unavailable
  )
    return previous;
  // Preserve the probe's scoped-model order: its first model names the
  // overage-included event bucket, even when another model sorts before it.
  const windows = previous?.windows.map((window) => (window.id === id ? next : window)) ?? [];
  if (!existing) {
    if (kind === "session") windows.unshift(next);
    else windows.push(next);
  }
  return { checkedAt, windows };
}

/** Failed or cached probes cannot erase fresher usage received during a turn. */
export function usageLimitsAfterProbe(
  published: ServerProviderUsageLimits | undefined,
  probed: ServerProviderUsageLimits | undefined,
): ServerProviderUsageLimits | undefined {
  if (probed?.unavailable?.reason === "unsupported") return probed;
  if (
    published &&
    !published.unavailable &&
    (probed?.unavailable?.reason === "probeFailed" ||
      (probed && Date.parse(published.checkedAt) > Date.parse(probed.checkedAt)))
  )
    return published;
  return probed;
}

export class CodexUsageLimitListener extends Context.Service<
  CodexUsageLimitListener,
  {
    readonly publish: (snapshot: CodexRateLimitSnapshot) => Effect.Effect<void>;
  }
>()("t3/provider/providerUsageLimits/CodexUsageLimitListener") {}

export function applyCodexRateLimitEvent(
  previous: ServerProviderUsageLimits | undefined,
  snapshot: CodexRateLimitSnapshot,
  checkedAt: string,
): ServerProviderUsageLimits | undefined {
  if (previous?.unavailable?.reason === "unsupported") return previous;
  const incoming = codexUsageLimits(snapshot, checkedAt);
  if (incoming.windows.length === 0) return previous;
  const windows = [...(previous?.windows ?? [])];
  let changed = false;
  for (const window of incoming.windows) {
    const index = windows.findIndex((current) => current.id === window.id);
    const existing = windows[index];
    const raw = window.id === "primary" ? snapshot.primary : snapshot.secondary;
    const next = {
      ...window,
      ...(window.resetsAt === undefined && existing?.resetsAt
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(raw?.windowDurationMins == null && snapshot.planType == null && existing
        ? {
            kind: existing.kind,
            label: existing.label,
            windowDurationMins: existing.windowDurationMins,
          }
        : {}),
    };
    if (
      existing &&
      existing.kind === next.kind &&
      existing.usedPercent === next.usedPercent &&
      existing.resetsAt === next.resetsAt &&
      existing.windowDurationMins === next.windowDurationMins
    )
      continue;
    changed = true;
    if (index < 0) windows.push(next);
    else windows[index] = next;
  }
  if (!changed && previous && !previous.unavailable) return previous;
  return {
    checkedAt,
    windows,
    ...(previous?.resetCredits ? { resetCredits: previous.resetCredits } : {}),
  };
}
