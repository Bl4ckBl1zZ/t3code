import type {
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

export type LimitProvider = Pick<
  ServerProvider,
  "enabled" | "installed" | "availability" | "driver" | "instanceId" | "displayName" | "usageLimits"
> & { readonly auth: Pick<ServerProvider["auth"], "email"> };

export interface LimitAccount {
  readonly id: string;
  readonly driver: ServerProvider["driver"];
  readonly label: string;
  readonly environments: readonly string[];
  readonly limits: ServerProviderUsageLimits | undefined;
}
export function collectLimitAccounts(
  environments: readonly {
    id: string;
    label: string;
    providers: readonly LimitProvider[];
  }[],
): readonly LimitAccount[] {
  const accounts = new Map<string, LimitAccount>();
  for (const environment of environments) {
    for (const provider of environment.providers) {
      if (!provider.enabled || !provider.installed || provider.availability === "unavailable")
        continue;
      if (!provider.usageLimits && provider.driver !== "codex" && provider.driver !== "claudeAgent")
        continue;
      const email = provider.auth.email?.trim().toLowerCase();
      const identity = email || `instance:${environment.id}:${provider.instanceId}`;
      const id = `${provider.driver}:${identity}`;
      const held = accounts.get(id);
      const newer =
        Date.parse(provider.usageLimits?.checkedAt ?? "") >
        Date.parse(held?.limits?.checkedAt ?? "1970-01-01");
      const label = provider.displayName || email || String(provider.instanceId);
      accounts.set(
        id,
        held
          ? {
              ...held,
              environments: [...new Set([...held.environments, environment.label])],
              limits: newer ? provider.usageLimits : held.limits,
            }
          : {
              id,
              driver: provider.driver,
              label,
              environments: [environment.label],
              limits: provider.usageLimits,
            },
      );
    }
  }
  return [...accounts.values()];
}
export interface LimitPoolMember {
  readonly account: LimitAccount;
  readonly window: ServerProviderUsageWindow;
}

/**
 * One window id across every account that reports it: the pooled share left,
 * pace against the clock, and the resets in the order they will land, each
 * with the share of the pool it hands back.
 */
export interface LimitPoolWindow {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly members: readonly LimitPoolMember[];
  /** Fixed account positions across rows; a null window leaves a gap. */
  readonly columns: ReadonlyArray<{
    readonly account: LimitAccount;
    readonly window: ServerProviderUsageWindow | null;
  }>;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly pace: LimitPace | null;
  readonly resets: ReadonlyArray<{
    readonly member: LimitPoolMember;
    readonly at: number;
    /** Points of the pool the reset restores: the member's used share over the member count. */
    readonly restoresPercent: number;
  }>;
}

export interface LimitPool {
  readonly driver: ServerProvider["driver"];
  readonly accounts: readonly LimitAccount[];
  readonly windows: readonly LimitPoolWindow[];
}

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

/**
 * Accounts grouped by driver, each with its windows pooled by kind and id.
 * Window ids are stable per provider, so a hub row and a native row for the
 * same window land in the same pool; the kind is part of the key because
 * Codex's `primary` is a position, not a duration (five hours on paid plans,
 * a month on Free/Go), and a monthly allowance must not average into a
 * five-hour pool. Pools order by kind, then first appearance.
 *
 * Accounts and columns share the session reset order, soonest first. When
 * no account reports a session window, use the first window by kind instead.
 * Missing reset times sort last, with account names and keys breaking ties.
 * Each window's reset list still follows its own clock.
 */
export function collectLimitPools(
  accounts: readonly LimitAccount[],
  now: number,
): readonly LimitPool[] {
  const byDriver = new Map<ServerProvider["driver"], LimitAccount[]>();
  for (const account of accounts) {
    if (!account.limits || account.limits.unavailable) continue;
    const list = byDriver.get(account.driver);
    if (list) list.push(account);
    else byDriver.set(account.driver, [account]);
  }
  return [...byDriver].map(([driver, members]) => {
    const orderWindow = members
      .flatMap((account) => account.limits?.windows ?? [])
      .sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind])[0];
    const orderReset = (account: LimitAccount) => {
      const window = (account.limits?.windows ?? []).find(
        (window) => window.kind === orderWindow?.kind && window.id === orderWindow.id,
      );
      return (window ? resetMillis(window) : null) ?? Number.POSITIVE_INFINITY;
    };
    const sorted = [...members].sort(
      (left, right) =>
        orderReset(left) - orderReset(right) ||
        accountSortName(left).localeCompare(accountSortName(right)) ||
        left.id.localeCompare(right.id),
    );
    return { driver, accounts: sorted, windows: poolWindows(sorted, now) };
  });
}

function accountSortName(account: LimitAccount): string {
  return account.label.toLowerCase();
}

function poolWindows(accounts: readonly LimitAccount[], now: number): readonly LimitPoolWindow[] {
  const byKey = new Map<string, LimitPoolMember[]>();
  for (const account of accounts) {
    if (!account.limits || account.limits.unavailable) continue;
    for (const window of account.limits?.windows ?? []) {
      const key = `${window.kind}:${window.id}`;
      const list = byKey.get(key);
      if (list) list.push({ account, window });
      else byKey.set(key, [{ account, window }]);
    }
  }
  const pools = [...byKey.values()].map((members): LimitPoolWindow => {
    const memberByAccount = new Map(members.map((member) => [member.account.id, member]));
    const first = members[0]!.window;
    const usedPercent = members.reduce((sum, m) => sum + m.window.usedPercent, 0) / members.length;
    // Pace compares spend against the clock, so it is judged only over the
    // members that have a clock; a window with no reset would otherwise
    // count as spend with no time elapsed and skew the verdict.
    const timed = members.flatMap((m) => {
      const share = elapsedShare(m.window, now);
      return share === null ? [] : [{ used: m.window.usedPercent, elapsed: share }];
    });
    const timedUsed = timed.reduce((sum, t) => sum + t.used, 0) / timed.length;
    const meanElapsed =
      timed.length > 0 ? timed.reduce((sum, t) => sum + t.elapsed, 0) / timed.length : null;
    const resets = members
      .flatMap((member) => {
        const at = resetMillis(member.window);
        return at === null
          ? []
          : [
              {
                member,
                at,
                restoresPercent: Math.round(member.window.usedPercent / members.length),
              },
            ];
      })
      .sort((left, right) => left.at - right.at);
    return {
      id: first.id,
      kind: first.kind,
      label: first.label,
      members,
      columns: accounts.map(
        (account) => memberByAccount.get(account.id) ?? { account, window: null },
      ),
      usedPercent: Math.round(usedPercent),
      remainingPercent: Math.round(100 - usedPercent),
      pace: meanElapsed === null ? null : paceOfShares(timedUsed, meanElapsed),
      resets,
    };
  });
  return pools.sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind]);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Quota left in the window, 0..100. Bars and labels show what remains, as Codex does. */
export function remainingPercent(window: ServerProviderUsageWindow): number {
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/** Elapsed share of the window, 0..1, or null when its length or reset is unknown. */
export function elapsedShare(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === undefined) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

export type LimitPace = "ahead" | "on" | "under";

/**
 * Usage against the clock. Spending evenly leaves the same share of quota as
 * there is time left in the window; within five points of that counts as on
 * pace, further ahead means the window may run dry first.
 */
export function paceOf(window: ServerProviderUsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : paceOfShares(window.usedPercent, elapsed);
}

function paceOfShares(usedPercent: number, elapsed: number): LimitPace {
  const gap = usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

/** `2h 13m`, `3d 4h`, `12m`. */
export function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** `resets in 2h 13m`, or null when the window has no reset. */
export function formatResetsIn(window: ServerProviderUsageWindow, now: number): string | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  return resetsAt <= now ? "resets now" : `resets in ${formatDuration(resetsAt - now)}`;
}
