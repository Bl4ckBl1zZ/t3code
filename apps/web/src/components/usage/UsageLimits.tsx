import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProviderUsageWindow } from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo, useRef, useState } from "react";
import { useNowMinute } from "../../hooks/useNowMinute";
import { isElectron } from "../../env";
import { environmentPresentations } from "../../state/presentation";
import { environmentSession } from "../../state/session";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "../settings/ProviderSettingsPanel.logic";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { Checkbox } from "../ui/checkbox";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import {
  collectLimitAccounts,
  collectLimitPools,
  elapsedShare,
  formatResetsIn,
  paceOf,
  remainingPercent,
} from "./usageLimits.logic";

const refreshAccessAtom = Atom.make(
  (get) =>
    new Map(
      [...get(environmentPresentations.presentationsAtom)].map(([id, environment]) => {
        const session = get(environmentSession.sessionStateAtom(id));
        const input = {
          session: Option.getOrNull(AsyncResult.value(session)),
          isPending: session.waiting,
          hasError: session._tag === "Failure",
        };
        const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
        return [
          id,
          isPrimary
            ? resolvePrimaryOperateAccess({ ...input, isPrimary, hasDesktopBridge: isElectron })
            : resolveRemoteOperateAccess(input),
        ] as const;
      }),
    ),
);

function LimitBar({
  remaining,
  timeLeft,
  label,
}: {
  remaining: number;
  timeLeft?: number | null;
  label: string;
}) {
  return (
    <div
      className="relative h-2 overflow-hidden rounded-full bg-muted"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(remaining)}
    >
      <div
        className="h-full rounded-full bg-primary"
        style={{ width: `${Math.max(0, Math.min(100, remaining))}%` }}
      />
      {timeLeft != null && (
        <span
          className="absolute inset-y-0 w-px bg-foreground/70"
          style={{ left: `${timeLeft * 100}%` }}
        />
      )}
    </div>
  );
}
function LimitWindow({ window, now }: { window: ServerProviderUsageWindow; now: number }) {
  const remaining = remainingPercent(window);
  const elapsed = elapsedShare(window, now);
  const pace = paceOf(window, now);
  return (
    <div className="grid min-w-0 gap-1.5 py-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span>{window.label}</span>
        <span className="tabular-nums">{remaining}% left</span>
      </div>
      <LimitBar
        remaining={remaining}
        timeLeft={elapsed === null ? null : 1 - elapsed}
        label={`${window.label}: quota remaining`}
      />
      <div className="flex flex-wrap justify-between gap-1 text-[11px] text-muted-foreground">
        <span>
          {pace === "ahead"
            ? "Spending ahead of pace"
            : pace === "under"
              ? "Under pace"
              : pace === "on"
                ? "On pace"
                : ""}
        </span>
        <Tooltip>
          <TooltipTrigger render={<span tabIndex={0} />}>
            {formatResetsIn(window, now) ?? "Reset not reported"}
          </TooltipTrigger>
          <TooltipPopup>{window.resetsAt ?? "Reset not reported"}</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}
export function UsageLimits({ onShowUsage }: { onShowUsage: () => void }) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const refreshAccess = useAtomValue(refreshAccessAtom);
  const [selected, setSelected] = useState<ReadonlySet<EnvironmentId> | null>(null);
  const [pending, setPending] = useState(false);
  const [failures, setFailures] = useState<readonly string[]>([]);
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const busy = useRef(false);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const targets = [...presentations].filter(([id]) => selected === null || selected.has(id));
  const accounts = useMemo(
    () =>
      collectLimitAccounts(
        [...presentations]
          .filter(([id]) => selected === null || selected.has(id))
          .map(([id, value]) => ({
            id,
            label: value.entry.target.label,
            providers: value.serverConfig?.providers ?? [],
          })),
      ),
    [presentations, selected],
  );
  const pools = useMemo(() => collectLimitPools(accounts, now), [accounts, now]);
  const refresh = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setFailures([]);
    const results = await Promise.all(
      targets.map(async ([environmentId, value]) => {
        if (value.connection.phase !== "connected")
          return `${value.entry.target.label} is offline.`;
        if (refreshAccess.get(environmentId) !== "granted")
          return `${value.entry.target.label} does not allow refreshing providers.`;
        const result = await refreshProviders({ environmentId, input: {} });
        return result._tag === "Failure"
          ? `${value.entry.target.label} could not refresh its limits.`
          : null;
      }),
    );
    setFailures(results.filter((value) => value !== null));

    setPending(false);
    busy.current = false;
  };
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron}>
        <div className="flex w-full min-w-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onShowUsage}>
            Usage
          </Button>
          <span className="text-sm font-medium">Limits</span>
          <Button
            className="ml-auto"
            variant="ghost"
            size="sm"
            disabled={
              pending ||
              !targets.some(
                ([id, value]) =>
                  value.connection.phase === "connected" && refreshAccess.get(id) === "granted",
              )
            }
            onClick={() => void refresh()}
          >
            <RefreshIcon className="size-3.5" refreshing={pending} />
            {pending ? "Refreshing…" : "Refresh limits"}
          </Button>
        </div>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        <WorkspacePageContainer width="wide">
          <div className="mb-6 flex flex-wrap gap-4" aria-label="Included environments">
            {[...presentations].map(([id, value]) => (
              <label key={id} className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={selected === null || selected.has(id)}
                  disabled={pending}
                  onCheckedChange={(checked) => {
                    const next = new Set(selected ?? presentations.keys());
                    if (checked) next.add(id);
                    else next.delete(id);
                    setSelected(next);
                  }}
                />
                {value.entry.target.label}
                {value.connection.phase !== "connected" ? " · Offline" : ""}
              </label>
            ))}
          </div>
          {failures.map((failure) => (
            <p key={failure} role="alert" className="mb-2 text-xs text-destructive">
              {failure}
            </p>
          ))}
          {pools.some((pool) => pool.accounts.length > 1) && (
            <section className="mb-8 grid gap-4">
              <h2 className="text-sm font-medium">Pooled accounts</h2>
              <p className="text-xs text-muted-foreground">
                Accounts have equal weight. Different plans may have different token allowances.
              </p>
              {pools
                .filter((pool) => pool.accounts.length > 1)
                .map((pool) => (
                  <div key={pool.driver} className="min-w-0 rounded-lg border p-4">
                    <h3 className="mb-3 text-sm font-medium">
                      {pool.driver === "claudeAgent" ? "Claude" : pool.driver} ·{" "}
                      {pool.accounts.length} accounts
                    </h3>
                    <div className="grid gap-4">
                      {pool.windows.map((window) => (
                        <div key={`${window.kind}:${window.id}`}>
                          <div className="mb-2 flex justify-between gap-2 text-xs">
                            <span>{window.label}</span>
                            <span>{window.remainingPercent}% left</span>
                          </div>
                          <LimitBar
                            remaining={window.remainingPercent}
                            label={`${window.label}: pooled quota remaining`}
                          />
                          <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
                            {window.resets.map(({ member, at, restoresPercent }) => (
                              <span key={member.account.id}>
                                {member.account.label}: {formatResetsIn(member.window, now)} ·{" "}
                                {at > now
                                  ? `restores ${restoresPercent} pool points`
                                  : "awaiting fresh report"}
                              </span>
                            ))}
                          </div>
                          <div
                            className="mt-3 grid gap-2"
                            style={{
                              gridTemplateColumns: `repeat(${pool.accounts.length}, minmax(0, 1fr))`,
                            }}
                          >
                            {window.columns.map(({ account, window: memberWindow }) => (
                              <div key={account.id} className="min-w-0">
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <div tabIndex={0} className="mb-1 truncate text-[11px]" />
                                    }
                                  >
                                    {account.label}
                                  </TooltipTrigger>
                                  <TooltipPopup>{account.label}</TooltipPopup>
                                </Tooltip>
                                {memberWindow ? (
                                  <LimitBar
                                    remaining={remainingPercent(memberWindow)}
                                    label={`${account.label}: ${window.label} remaining`}
                                  />
                                ) : (
                                  <span className="text-[11px] text-muted-foreground">
                                    Not reported
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
            </section>
          )}
          <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {accounts.map((account) => (
              <section key={account.id} className="min-w-0 rounded-xl border bg-card/30 p-4">
                <h2 className="flex items-center gap-2 text-sm font-medium">
                  <GaugeIcon className="size-4" />
                  {account.label}
                </h2>
                <p className="mt-1 mb-3 truncate text-xs text-muted-foreground">
                  {account.environments.join(" · ")}
                </p>
                {!account.limits ? (
                  <p className="text-xs text-muted-foreground">
                    No limits reported. Refresh to check.
                  </p>
                ) : account.limits.unavailable ? (
                  <p className="text-xs text-muted-foreground">
                    {account.limits.unavailable.message ??
                      (account.limits.unavailable.reason === "unsupported"
                        ? "Limits are not supported for this account."
                        : "Limits could not be checked.")}
                  </p>
                ) : account.limits.windows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No quota windows reported.</p>
                ) : (
                  account.limits.windows.map((window) => (
                    <LimitWindow key={window.id} window={window} now={now} />
                  ))
                )}
                {account.limits && (
                  <p className="mt-3 text-[11px] text-muted-foreground">
                    Checked {new Date(account.limits.checkedAt).toLocaleString()}
                    {now - Date.parse(account.limits.checkedAt) > 15 * 60_000
                      ? " · May be stale"
                      : ""}
                  </p>
                )}
              </section>
            ))}
          </div>
          {accounts.length === 0 && (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No accounts reporting limits in the selected environments.
            </p>
          )}
        </WorkspacePageContainer>
      </div>
    </SidebarInset>
  );
}
