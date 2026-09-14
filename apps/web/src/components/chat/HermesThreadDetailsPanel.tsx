import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  BotIcon,
  ChevronRightIcon,
  MonitorIcon,
  CalendarClockIcon,
  CopyIcon,
  FolderIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useHermesConnection } from "../../hooks/useHermesConnection";
import { useHermesProfile } from "../../hooks/useHermesProfile";
import { useEnvironment } from "../../state/environments";
import { hermesEnvironment } from "../../state/hermes";
import { useEnvironmentQuery } from "../../state/query";
import { useWorkEnvironmentScopePreference } from "../../workEnvironmentScope";
import { Button } from "../ui/button";
import { hermesThreadScheduleSummary } from "./HermesThreadDetailsPanel.logic";
import {
  THREAD_DETAILS_PANEL_ROW_CLASS,
  THREAD_DETAILS_PANEL_ICON_ACTION_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
} from "./threadDetailsPanelStyles";

/** Fetch native details only when the existing thread panel is mounted; never poll it. */
export function HermesThreadDetailsPanel({
  environmentId,
  threadId,
  isServerThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly isServerThread: boolean;
}) {
  const navigate = useNavigate();
  const environment = useEnvironment(environmentId);
  const query = useEnvironmentQuery(
    isServerThread
      ? hermesEnvironment.workQuery({
          environmentId,
          input: {
            section: "thread",
            id: threadId,
            providerInstanceId: "",
            profile: "default",
          },
        })
      : null,
  );
  const details = query.data?.threadDetails;
  const changes = useEnvironmentQuery(
    details?.providerInstanceId
      ? hermesEnvironment.workChanges({
          environmentId,
          input: { providerInstanceId: details.providerInstanceId },
        })
      : null,
  );
  const refresh = query.refresh;
  useEffect(() => {
    if (changes.data) refresh();
  }, [changes.data, refresh]);
  const diagnostics = [...new Set(query.data?.diagnostics ?? [])];
  const [, setEnvironmentScope] = useWorkEnvironmentScopePreference();
  const [, setConnection] = useHermesConnection(environmentId);
  const [, setProfile] = useHermesProfile(environmentId, details?.providerInstanceId ?? null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "Hermes workspace path",
    onError: (error) => setCopyError(error.message),
    onCopy: () => setCopyError(null),
  });

  function manageSchedules() {
    if (!details?.providerInstanceId || !details.profile) return;
    setEnvironmentScope(environmentId);
    setConnection(details.providerInstanceId);
    setProfile(details.profile);
    void navigate({ to: "/settings/hermes-cron" });
  }

  return (
    <>
      <section
        className="px-2 pb-2.5 pt-2"
        aria-labelledby="thread-details-hermes-workspace-heading"
        data-hermes-thread-details
      >
        <div className="mb-1 flex min-h-8 items-center justify-between gap-2 px-2">
          <h3
            id="thread-details-hermes-workspace-heading"
            className="text-[11px] font-medium text-muted-foreground"
          >
            Workspace
          </h3>
          {isServerThread ? (
            <Button
              size="icon-xs"
              variant="ghost"
              className={THREAD_DETAILS_PANEL_ICON_ACTION_CLASS}
              aria-label="Refresh assistant details"
              disabled={query.isPending}
              onClick={() => query.refresh()}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
        {!isServerThread ? (
          <p className="px-2.5 text-xs leading-relaxed text-muted-foreground">
            The assistant’s workspace and session details appear when this conversation starts.
          </p>
        ) : null}
        {query.isPending && !details ? (
          <p role="status" className="px-2.5 text-xs text-muted-foreground">
            Loading assistant details…
          </p>
        ) : null}
        {query.error ? (
          <div
            role="alert"
            className="mx-1.5 my-2 rounded-lg border border-warning/30 bg-warning/6 p-2.5"
          >
            <p className="text-xs">Could not load current assistant details.</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{query.error}</p>
          </div>
        ) : null}
        {details?.status === "unavailable" && !query.error && diagnostics.length === 0 ? (
          <p role="status" className="px-2.5 py-1 text-xs text-muted-foreground">
            The native session is currently unavailable. Showing the saved assistant identity where
            available.
          </p>
        ) : null}
        {diagnostics
          .filter((diagnostic) => diagnostic !== query.error)
          .map((diagnostic) => (
            <p
              key={diagnostic}
              className="px-2.5 py-1 text-[11px] leading-relaxed text-muted-foreground"
            >
              {diagnostic}
            </p>
          ))}
        {isServerThread &&
        !query.isPending &&
        !query.error &&
        query.data &&
        (!details || details.status === "unbound") ? (
          <p className="px-2.5 text-xs leading-relaxed text-muted-foreground">
            {details?.status === "unbound"
              ? "This conversation has no linked Hermes session. Saved conversation history remains available."
              : "The server has not reported assistant session details."}
          </p>
        ) : null}
        {details && details.status !== "unbound" ? (
          <>
            <Button
              variant="ghost"
              className={THREAD_DETAILS_PANEL_ROW_CLASS}
              disabled={!details.workspacePath}
              title={details.workspacePath ?? undefined}
              aria-label={
                details.workspacePath
                  ? `Copy workspace path: ${details.workspacePath}`
                  : "Workspace unavailable"
              }
              onClick={() => copyToClipboard(details.workspacePath ?? "", undefined)}
            >
              <FolderIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span className="min-w-0 flex-1 truncate text-left">
                {details.workspacePath?.split(/[\\/]/).findLast(Boolean) ?? "Workspace unavailable"}
              </span>
              <CopyIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </Button>
            <div className="flex h-9 items-center gap-2.5 px-2.5 text-[13px] text-foreground/80">
              <MonitorIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span className="truncate">{environment?.label ?? "Hosting environment"}</span>
            </div>
            <div className="flex h-9 items-center gap-2.5 px-2.5 text-[13px] text-foreground/80">
              <BotIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span className="truncate">
                {details.profile === "default"
                  ? "Default assistant"
                  : (details.profile ?? "Assistant unavailable")}
              </span>
            </div>
            {copyError ? (
              <p role="alert" className="px-2.5 text-[11px] text-destructive">
                {copyError}
              </p>
            ) : null}
            {isCopied ? (
              <p role="status" className="px-2.5 text-[11px] text-muted-foreground">
                Workspace path copied
              </p>
            ) : null}
            <details className="group/session mt-1">
              <summary className="flex h-8 cursor-pointer list-none items-center gap-2 px-2.5 text-[11px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon className="size-3 group-open/session:rotate-90" />
                Session details
              </summary>
              <dl className="space-y-2 px-2.5 pb-2 pt-1">
                <IdentityRow label="Session" value={details.sessionId ?? "Unavailable"} />
                <IdentityRow label="Full path" value={details.workspacePath ?? "Unavailable"} />
              </dl>
            </details>
          </>
        ) : null}
      </section>
      {details && details.status !== "unbound" ? (
        <section
          className="border-t border-border/65 px-2 pb-2.5 pt-2"
          aria-labelledby="thread-details-hermes-schedules-heading"
        >
          <div className="mb-1 flex min-h-8 items-center justify-between gap-2 px-2">
            <h3
              id="thread-details-hermes-schedules-heading"
              className="text-[11px] font-medium text-muted-foreground"
            >
              Scheduled tasks
            </h3>
          </div>
          <div className="flex items-center gap-2 px-2.5 pb-2 text-[11px] text-muted-foreground">
            <span
              className={`size-1.5 shrink-0 rounded-full ${details.gatewayRunning === true ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
            />
            {details.gatewayRunning === true
              ? "Scheduler running"
              : details.gatewayRunning === false
                ? "Scheduler stopped"
                : "Scheduler status unavailable"}
          </div>
          {details.schedules.length === 0 ? (
            <p className="px-2.5 py-1 text-xs leading-relaxed text-muted-foreground">
              {details.schedulesAvailable === false ||
              (details.schedulesAvailable === undefined && details.status === "unavailable")
                ? "Linked tasks are currently unavailable."
                : "No linked tasks yet."}
            </p>
          ) : (
            <ul className="m-0 list-none p-0">
              {details.schedules.map((task) => {
                const summary = hermesThreadScheduleSummary(task);
                return (
                  <li key={task.id} className="flex items-start gap-2.5 rounded-lg px-2.5 py-2">
                    <CalendarClockIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-[13px] font-medium text-foreground/80">
                        {task.name || task.id}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {task.relationship === "created_here"
                          ? "Created in this conversation"
                          : "This conversation is a scheduled run"}
                      </p>
                      <p className="mt-1 break-words text-[11px] text-muted-foreground">
                        {task.schedule || "Schedule not reported"} · {summary.timing}
                      </p>
                      {summary.outcome ? (
                        <p className="mt-1 text-[11px] text-muted-foreground">{summary.outcome}</p>
                      ) : null}
                      {task.lastError ? (
                        <p className="mt-1 break-words text-[11px] text-destructive">
                          {task.lastError}
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <Button
            size="xs"
            variant="ghost"
            className={THREAD_DETAILS_PANEL_ROW_CLASS}
            disabled={!details.providerInstanceId || !details.profile}
            onClick={manageSchedules}
          >
            <CalendarClockIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span className="flex-1 text-left">Manage schedules</span>
            <ChevronRightIcon className="size-3.5 text-muted-foreground" />
          </Button>
        </section>
      ) : null}
    </>
  );
}

function IdentityRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[11px] text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 break-all text-right text-[11px] text-foreground/80">{value}</dd>
    </div>
  );
}
