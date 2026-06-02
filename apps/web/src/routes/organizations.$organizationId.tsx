import {
  OrganizationId,
  type OrganizationPanelEvent,
  type OrganizationPanelSnapshot,
  type OrganizationPanelTurnId,
  type OrganizationPanelVersion,
} from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HistoryIcon, PanelTopIcon, RotateCcwIcon, SendIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { OrganizationPanelHost } from "../organizationPanel/OrganizationPanelHost";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { Textarea } from "../components/ui/textarea";
import { getPrimaryEnvironmentConnection } from "../environments/runtime";
import { isElectron } from "../env";
import { cn } from "../lib/utils";

interface ActivityState {
  readonly events: readonly OrganizationPanelEvent[];
  readonly activeTurnId: OrganizationPanelTurnId | null;
  readonly validationStatus: "idle" | "passed" | "failed";
  readonly compileStatus: "idle" | "passed" | "failed";
}

const EMPTY_ACTIVITY: ActivityState = {
  events: [],
  activeTurnId: null,
  validationStatus: "idle",
  compileStatus: "idle",
};

export const Route = createFileRoute("/organizations/$organizationId")({
  beforeLoad: async ({ context }) => {
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: OrganizationPanelRouteView,
});

function OrganizationPanelRouteView() {
  const { organizationId: rawOrganizationId } = Route.useParams();
  const organizationId = useMemo(() => OrganizationId.make(rawOrganizationId), [rawOrganizationId]);
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [activity, setActivity] = useState<ActivityState>(EMPTY_ACTIVITY);
  const panelQueryKey = useMemo(
    () => ["organization-panel", organizationId] as const,
    [organizationId],
  );
  const historyQueryKey = useMemo(
    () => ["organization-panel-history", organizationId] as const,
    [organizationId],
  );

  const panelQuery = useQuery({
    queryKey: panelQueryKey,
    queryFn: () =>
      getPrimaryEnvironmentConnection().client.organizationPanel.get({
        organizationId,
      }),
  });
  const historyQuery = useQuery({
    queryKey: historyQueryKey,
    queryFn: () =>
      getPrimaryEnvironmentConnection().client.organizationPanel.listHistory({
        organizationId,
        limit: 20,
      }),
  });

  useEffect(() => {
    setActivity(EMPTY_ACTIVITY);
  }, [organizationId]);

  useEffect(() => {
    const client = getPrimaryEnvironmentConnection().client;
    return client.organizationPanel.subscribe(
      { organizationId },
      (event) => {
        setActivity((current) => applyActivityEvent(current, event));
        if (event.type === "panel.snapshot" || event.type === "turn.completed") {
          void queryClient.invalidateQueries({ queryKey: panelQueryKey });
          void queryClient.invalidateQueries({ queryKey: historyQueryKey });
        }
      },
      {
        onResubscribe: () => {
          void queryClient.invalidateQueries({ queryKey: panelQueryKey });
          void queryClient.invalidateQueries({ queryKey: historyQueryKey });
        },
      },
    );
  }, [historyQueryKey, organizationId, panelQueryKey, queryClient]);

  const startTurnMutation = useMutation({
    mutationFn: (nextPrompt: string) =>
      getPrimaryEnvironmentConnection().client.organizationPanel.startTurn({
        organizationId,
        prompt: nextPrompt,
      }),
    onSuccess: () => {
      setPrompt("");
      void queryClient.invalidateQueries({ queryKey: panelQueryKey });
      void queryClient.invalidateQueries({ queryKey: historyQueryKey });
    },
  });
  const stopTurnMutation = useMutation({
    mutationFn: (turnId: OrganizationPanelTurnId) =>
      getPrimaryEnvironmentConnection().client.organizationPanel.stopTurn({
        organizationId,
        turnId,
      }),
  });
  const rollbackMutation = useMutation({
    mutationFn: (version: OrganizationPanelVersion) =>
      getPrimaryEnvironmentConnection().client.organizationPanel.rollback({
        organizationId,
        versionId: version.id,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: panelQueryKey });
      void queryClient.invalidateQueries({ queryKey: historyQueryKey });
    },
  });

  const snapshot = panelQuery.data ?? null;
  const history = historyQuery.data?.versions ?? [];
  const canSubmit =
    prompt.trim().length > 0 && !startTurnMutation.isPending && !activity.activeTurnId;
  const pageTitle = snapshot?.organization.name ?? rawOrganizationId;
  const latestVersion = snapshot?.latestVersion ?? history[0] ?? null;

  const startTurn = useCallback(() => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      return;
    }
    void startTurnMutation.mutateAsync(trimmedPrompt);
  }, [prompt, startTurnMutation]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <header
          className={cn(
            "shrink-0 border-b border-border px-3 sm:px-5",
            isElectron
              ? "drag-region flex h-[52px] items-center wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]"
              : "py-2 sm:py-3",
          )}
        >
          <div className="flex min-h-7 min-w-0 flex-1 items-center gap-2 sm:min-h-6">
            {!isElectron ? <SidebarTrigger className="size-7 shrink-0 md:hidden" /> : null}
            <PanelTopIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {pageTitle}
            </span>
            {snapshot ? (
              <Badge size="sm" variant="outline" className="ml-auto">
                {snapshot.panel.panelSlug}
              </Badge>
            ) : null}
          </div>
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6">
            {panelQuery.error ? (
              <Alert variant="error" className="rounded-lg">
                <AlertTitle>Organization panel unavailable</AlertTitle>
                <AlertDescription>{errorMessage(panelQuery.error)}</AlertDescription>
              </Alert>
            ) : null}

            {snapshot ? (
              <>
                <OrganizationPanelControls
                  snapshot={snapshot}
                  prompt={prompt}
                  setPrompt={setPrompt}
                  canSubmit={canSubmit}
                  activeTurnId={activity.activeTurnId}
                  startPending={startTurnMutation.isPending}
                  stopPending={stopTurnMutation.isPending}
                  latestVersion={latestVersion}
                  rollbackPending={rollbackMutation.isPending}
                  startTurn={startTurn}
                  stopTurn={(turnId) => void stopTurnMutation.mutateAsync(turnId)}
                  rollback={(version) => void rollbackMutation.mutateAsync(version)}
                />

                <div className="grid min-h-[28rem] gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
                  <section className="min-w-0 overflow-hidden rounded-lg border border-border bg-background">
                    <OrganizationPanelHost snapshot={snapshot} />
                  </section>

                  <aside className="flex min-h-0 flex-col gap-4">
                    <PanelActivitySurface activity={activity} />
                    <PanelHistorySurface
                      versions={history}
                      rollbackPending={rollbackMutation.isPending}
                      rollback={(version) => void rollbackMutation.mutateAsync(version)}
                    />
                  </aside>
                </div>
              </>
            ) : !panelQuery.error ? (
              <div className="text-sm text-muted-foreground">Loading organization panel...</div>
            ) : null}
          </main>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function OrganizationPanelControls(props: {
  readonly snapshot: OrganizationPanelSnapshot;
  readonly prompt: string;
  readonly setPrompt: (prompt: string) => void;
  readonly canSubmit: boolean;
  readonly activeTurnId: OrganizationPanelTurnId | null;
  readonly startPending: boolean;
  readonly stopPending: boolean;
  readonly latestVersion: OrganizationPanelVersion | null;
  readonly rollbackPending: boolean;
  readonly startTurn: () => void;
  readonly stopTurn: (turnId: OrganizationPanelTurnId) => void;
  readonly rollback: (version: OrganizationPanelVersion) => void;
}) {
  return (
    <section className="grid gap-4 rounded-lg border border-border bg-card/35 p-4 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{props.snapshot.organization.name}</span>
          <span className="truncate">{props.snapshot.panel.panelFilePath}</span>
        </div>
        <Textarea
          value={props.prompt}
          rows={3}
          placeholder="Add monthly revenue, active users, and open tickets."
          className="min-h-20 resize-y"
          onChange={(event) => props.setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              props.startTurn();
            }
          }}
        />
      </div>
      <div className="flex flex-wrap items-end gap-2 lg:flex-col lg:justify-end">
        <Button size="sm" disabled={!props.canSubmit} onClick={props.startTurn}>
          <SendIcon className="size-4" />
          {props.startPending ? "Sending" : "Send"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!props.activeTurnId || props.stopPending}
          onClick={() => props.activeTurnId && props.stopTurn(props.activeTurnId)}
        >
          <SquareIcon className="size-4" />
          Stop
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!props.latestVersion || props.rollbackPending}
          onClick={() => props.latestVersion && props.rollback(props.latestVersion)}
        >
          <RotateCcwIcon className="size-4" />
          Rollback
        </Button>
      </div>
    </section>
  );
}

function PanelActivitySurface({ activity }: { readonly activity: ActivityState }) {
  return (
    <section className="min-h-0 rounded-lg border border-border bg-card/35">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">Activity</h2>
        <div className="flex gap-1">
          <StatusBadge label="Validation" status={activity.validationStatus} />
          <StatusBadge label="Compile" status={activity.compileStatus} />
        </div>
      </div>
      <div className="max-h-80 overflow-auto p-3">
        {activity.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No panel activity yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {activity.events.map((event, index) => (
              <div key={eventKey(event, index)} className="rounded-md border border-border/70 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">{eventLabel(event)}</span>
                  <Badge size="sm" variant={eventTone(event)}>
                    {event.type}
                  </Badge>
                </div>
                {event.type === "file.patch" && event.diff ? (
                  <pre className="mt-2 max-h-44 overflow-auto rounded-md bg-background p-2 text-[11px] leading-relaxed text-muted-foreground">
                    {event.diff}
                  </pre>
                ) : null}
                {"errors" in event && event.errors.length > 0 ? (
                  <ul className="mt-2 space-y-1 text-xs text-destructive">
                    {event.errors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function PanelHistorySurface(props: {
  readonly versions: readonly OrganizationPanelVersion[];
  readonly rollbackPending: boolean;
  readonly rollback: (version: OrganizationPanelVersion) => void;
}) {
  return (
    <section className="rounded-lg border border-border bg-card/35">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <HistoryIcon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">History</h2>
      </div>
      <div className="max-h-80 overflow-auto p-3">
        {props.versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No saved versions yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {props.versions.map((version) => (
              <div key={version.id} className="rounded-md border border-border/70 p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">{version.prompt}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {new Date(version.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    aria-label={`Rollback version from ${new Date(version.createdAt).toLocaleString()}`}
                    disabled={props.rollbackPending}
                    onClick={() => props.rollback(version)}
                  >
                    <RotateCcwIcon className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function StatusBadge(props: {
  readonly label: string;
  readonly status: ActivityState["validationStatus"];
}) {
  if (props.status === "idle") {
    return (
      <Badge size="sm" variant="outline">
        {props.label}
      </Badge>
    );
  }
  return (
    <Badge size="sm" variant={props.status === "passed" ? "success" : "error"}>
      {props.label}
    </Badge>
  );
}

function applyActivityEvent(state: ActivityState, event: OrganizationPanelEvent): ActivityState {
  const events = [...state.events, event].slice(-40);
  switch (event.type) {
    case "turn.started":
      return {
        ...state,
        events,
        activeTurnId: event.turnId,
        validationStatus: "idle",
        compileStatus: "idle",
      };
    case "validation.result":
      return { ...state, events, validationStatus: event.status };
    case "compile.result":
      return { ...state, events, compileStatus: event.status };
    case "turn.completed":
    case "turn.failed":
      return { ...state, events, activeTurnId: null };
    default:
      return { ...state, events };
  }
}

function eventLabel(event: OrganizationPanelEvent): string {
  switch (event.type) {
    case "turn.started":
      return event.prompt;
    case "turn.delta":
      return event.message;
    case "file.patch":
      return event.filePath;
    case "validation.result":
    case "compile.result":
      return event.errors.length > 0 ? event.errors.join(", ") : event.status;
    case "turn.completed":
      return event.versionId;
    case "turn.failed":
      return event.reason;
    case "panel.snapshot":
      return event.panelFilePath;
  }
}

function eventTone(event: OrganizationPanelEvent): "outline" | "success" | "error" | "info" {
  if (event.type === "turn.failed") {
    return "error";
  }
  if (
    (event.type === "validation.result" || event.type === "compile.result") &&
    event.status === "failed"
  ) {
    return "error";
  }
  if (event.type === "turn.completed") {
    return "success";
  }
  if (event.type === "turn.delta" || event.type === "file.patch") {
    return "info";
  }
  return "outline";
}

function eventKey(event: OrganizationPanelEvent, index: number): string {
  switch (event.type) {
    case "panel.snapshot":
      return `${index}:${event.type}:${event.organizationId}:${event.versionId}`;
    case "turn.started":
      return `${index}:${event.type}:${event.organizationId}:${event.turnId}:${event.prompt}`;
    case "turn.delta":
      return `${index}:${event.type}:${event.organizationId}:${event.turnId}:${event.message}`;
    case "file.patch":
      return `${index}:${event.type}:${event.organizationId}:${event.turnId}:${event.filePath}:${event.diff.length}`;
    case "validation.result":
    case "compile.result":
      return `${index}:${event.type}:${event.organizationId}:${event.turnId}:${event.status}:${event.errors.join("|")}`;
    case "turn.completed":
      return `${index}:${event.type}:${event.organizationId}:${event.turnId}:${event.versionId}`;
    case "turn.failed":
      return `${index}:${event.type}:${event.organizationId}:${event.turnId}:${event.reason}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
