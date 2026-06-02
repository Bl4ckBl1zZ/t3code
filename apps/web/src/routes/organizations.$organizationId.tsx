import {
  OrganizationId,
  type OrganizationPanelEvent,
  type OrganizationPanelSnapshot,
  type OrganizationPanelTurnId,
  type OrganizationPanelVersion,
} from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PanelTopIcon, RotateCcwIcon, SquareIcon } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../components/ComposerPromptEditor";
import { OrganizationPanelHost } from "../organizationPanel/OrganizationPanelHost";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { Separator } from "../components/ui/separator";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { getPrimaryEnvironmentConnection } from "../environments/runtime";
import { isElectron } from "../env";
import { cn } from "../lib/utils";

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
  const [activeTurnId, setActiveTurnId] = useState<OrganizationPanelTurnId | null>(null);
  const panelQueryKey = useMemo(
    () => ["organization-panel", organizationId] as const,
    [organizationId],
  );

  const panelQuery = useQuery({
    queryKey: panelQueryKey,
    queryFn: () =>
      getPrimaryEnvironmentConnection().client.organizationPanel.get({
        organizationId,
      }),
  });

  useEffect(() => {
    setActiveTurnId(null);
  }, [organizationId]);

  useEffect(() => {
    const client = getPrimaryEnvironmentConnection().client;
    return client.organizationPanel.subscribe(
      { organizationId },
      (event) => {
        setActiveTurnId((current) => applyActiveTurnEvent(current, event));
        if (event.type === "panel.snapshot" || event.type === "turn.completed") {
          void queryClient.invalidateQueries({ queryKey: panelQueryKey });
        }
      },
      {
        onResubscribe: () => {
          void queryClient.invalidateQueries({ queryKey: panelQueryKey });
        },
      },
    );
  }, [organizationId, panelQueryKey, queryClient]);

  const startTurnMutation = useMutation({
    mutationFn: (nextPrompt: string) =>
      getPrimaryEnvironmentConnection().client.organizationPanel.startTurn({
        organizationId,
        prompt: nextPrompt,
      }),
    onSuccess: (result) => {
      setPrompt("");
      setActiveTurnId(null);
      queryClient.setQueryData(panelQueryKey, result.snapshot);
    },
    onError: () => {
      setActiveTurnId(null);
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
    onSuccess: (result) => {
      queryClient.setQueryData(panelQueryKey, result.snapshot);
    },
  });

  const snapshot = panelQuery.data ?? null;
  const canSubmit = prompt.trim().length > 0 && !startTurnMutation.isPending && !activeTurnId;
  const pageTitle = snapshot?.organization.name ?? rawOrganizationId;
  const latestVersion = snapshot?.latestVersion ?? null;

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
                  activeTurnId={activeTurnId}
                  startPending={startTurnMutation.isPending}
                  stopPending={stopTurnMutation.isPending}
                  latestVersion={latestVersion}
                  rollbackPending={rollbackMutation.isPending}
                  startTurn={startTurn}
                  stopTurn={(turnId) => void stopTurnMutation.mutateAsync(turnId)}
                  rollback={(version) => void rollbackMutation.mutateAsync(version)}
                />

                <section className="min-h-[28rem] min-w-0 overflow-hidden rounded-lg border border-border bg-background">
                  <OrganizationPanelHost snapshot={snapshot} />
                </section>
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
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const [composerCursor, setComposerCursor] = useState(0);
  const submitDisabled = !props.canSubmit;
  const isRunning = props.activeTurnId !== null;

  const submitPrompt = useCallback(
    (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      if (submitDisabled) {
        return;
      }
      props.startTurn();
    },
    [props, submitDisabled],
  );

  return (
    <form onSubmit={submitPrompt} className="mx-auto w-full min-w-0 max-w-208">
      <div className="group rounded-[22px] p-px transition-colors duration-200">
        <div className="rounded-[20px] border border-border bg-card transition-colors duration-200 has-focus-visible:border-ring/45">
          <div className="relative px-3 pb-2 pt-3.5 sm:px-4 sm:pt-4">
            <ComposerPromptEditor
              editorRef={editorRef}
              value={props.prompt}
              cursor={composerCursor}
              terminalContexts={[]}
              skills={[]}
              disabled={props.startPending}
              placeholder="Describe what this organization panel should show."
              onRemoveTerminalContext={() => {}}
              onPaste={() => {}}
              onChange={(nextPrompt, nextCursor) => {
                props.setPrompt(nextPrompt);
                setComposerCursor(nextCursor);
              }}
              onCommandKeyDown={(key, event) => {
                if (key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  submitPrompt();
                  return true;
                }
                return false;
              }}
            />
          </div>

          <div className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-2.5 pb-2.5 sm:px-3 sm:pb-3">
            <div className="-m-1 flex min-w-0 flex-1 items-center gap-2 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <span className="min-w-0 truncate rounded-full border border-border/60 bg-background/55 px-2.5 py-1 text-xs font-medium text-foreground">
                {props.snapshot.organization.name}
              </span>
              <Separator orientation="vertical" className="hidden h-4 sm:block" />
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {props.snapshot.panel.panelFilePath}
              </span>
            </div>

            <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex">
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="rounded-full text-muted-foreground hover:text-foreground"
                        disabled={!props.latestVersion || props.rollbackPending}
                        aria-label="Rollback latest organization panel version"
                        onPointerDown={(event) => {
                          event.preventDefault();
                        }}
                        onClick={() => props.latestVersion && props.rollback(props.latestVersion)}
                      >
                        <RotateCcwIcon className="size-4" />
                      </Button>
                    </span>
                  }
                />
                <TooltipPopup side="top" align="end">
                  Rollback latest version
                </TooltipPopup>
              </Tooltip>

              {isRunning ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex">
                        <button
                          type="button"
                          className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-rose-500/90 text-white transition-all duration-150 hover:scale-105 hover:bg-rose-500 disabled:pointer-events-none disabled:opacity-30 disabled:hover:scale-100 sm:h-8 sm:w-8"
                          disabled={props.stopPending}
                          aria-label="Stop panel generation"
                          onPointerDown={(event) => {
                            event.preventDefault();
                          }}
                          onClick={() => props.activeTurnId && props.stopTurn(props.activeTurnId)}
                        >
                          <SquareIcon className="size-3.5 fill-current" />
                        </button>
                      </span>
                    }
                  />
                  <TooltipPopup side="top" align="end">
                    Stop generation
                  </TooltipPopup>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex">
                        <button
                          type="submit"
                          className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/90 text-primary-foreground transition-all duration-150 enabled:cursor-pointer hover:scale-105 hover:bg-primary disabled:pointer-events-none disabled:opacity-30 disabled:hover:scale-100 sm:h-8 sm:w-8"
                          disabled={submitDisabled}
                          aria-label={props.startPending ? "Sending" : "Send message"}
                          onPointerDown={(event) => {
                            event.preventDefault();
                          }}
                        >
                          {props.startPending ? (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 14 14"
                              fill="none"
                              className="animate-spin"
                              aria-hidden="true"
                            >
                              <circle
                                cx="7"
                                cy="7"
                                r="5.5"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeDasharray="20 12"
                              />
                            </svg>
                          ) : (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 14 14"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path
                                d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </button>
                      </span>
                    }
                  />
                  <TooltipPopup side="top" align="end">
                    Send
                  </TooltipPopup>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}

function applyActiveTurnEvent(
  activeTurnId: OrganizationPanelTurnId | null,
  event: OrganizationPanelEvent,
): OrganizationPanelTurnId | null {
  switch (event.type) {
    case "turn.started":
      return event.turnId;
    case "turn.completed":
    case "turn.failed":
      return null;
    default:
      return activeTurnId;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
