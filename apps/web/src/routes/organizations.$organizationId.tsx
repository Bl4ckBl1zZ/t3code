import {
  OrganizationId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type OrganizationPanelActiveTurn,
  type OrganizationPanelEvent,
  type OrganizationPanelSnapshot,
  type OrganizationPanelTurnId,
  type OrganizationPanelVersion,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ImageIcon,
  PanelTopIcon,
  RotateCcwIcon,
  SquareIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import type { ClipboardEvent, FormEvent, UIEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readFileAsDataUrl } from "../components/ChatView.logic";
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
import { cn, randomUUID } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";

const PANEL_IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;

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
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [liveTurns, setLiveTurns] = useState<readonly OrganizationPanelLiveTurn[]>([]);
  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const [threadPreviewDismissed, setThreadPreviewDismissed] = useState(false);
  const [panelChatClearedAt, setPanelChatClearedAt] = useState<number | null>(null);
  const [panelImages, setPanelImages] = useState<readonly PanelComposerImageAttachment[]>([]);
  const [panelAttachmentError, setPanelAttachmentError] = useState<string | null>(null);
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
        limit: 12,
      }),
  });

  useEffect(() => {
    setActiveTurnId(null);
    setPendingPrompt(null);
    setLiveTurns([]);
    setComposerCollapsed(false);
    setThreadPreviewDismissed(false);
    setPanelChatClearedAt(null);
    setPanelAttachmentError(null);
    setPanelImages((images) => {
      revokePanelComposerImageUrls(images);
      return [];
    });
  }, [organizationId]);

  const panelImagesRef = useRef<readonly PanelComposerImageAttachment[]>([]);
  useEffect(() => {
    panelImagesRef.current = panelImages;
  }, [panelImages]);
  useEffect(
    () => () => {
      revokePanelComposerImageUrls(panelImagesRef.current);
    },
    [],
  );

  useEffect(() => {
    const client = getPrimaryEnvironmentConnection().client;
    return client.organizationPanel.subscribe(
      { organizationId },
      (event) => {
        setActiveTurnId((current) => applyActiveTurnEvent(current, event));
        setLiveTurns((current) => applyLiveTurnEvent(current, event));
        if (event.type === "turn.started") {
          setPendingPrompt(null);
        }
        if (event.type !== "panel.snapshot") {
          setThreadPreviewDismissed(false);
        }
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
    mutationFn: (input: {
      readonly prompt: string;
      readonly attachments: UploadChatAttachment[];
    }) =>
      getPrimaryEnvironmentConnection().client.organizationPanel.startTurn({
        organizationId,
        prompt: input.prompt,
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
      }),
    onSuccess: (result) => {
      setPrompt("");
      setPanelAttachmentError(null);
      setPanelImages((images) => {
        revokePanelComposerImageUrls(images);
        return [];
      });
      setActiveTurnId(null);
      setPendingPrompt(null);
      queryClient.setQueryData(panelQueryKey, result.snapshot);
      void queryClient.invalidateQueries({ queryKey: historyQueryKey });
    },
    onError: () => {
      setActiveTurnId(null);
      setPendingPrompt(null);
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
      void queryClient.invalidateQueries({ queryKey: historyQueryKey });
    },
  });

  const snapshot = panelQuery.data ?? null;
  const canSubmit =
    (prompt.trim().length > 0 || panelImages.length > 0) &&
    !startTurnMutation.isPending &&
    !activeTurnId;
  const pageTitle = snapshot?.organization.name ?? rawOrganizationId;
  const latestVersion = snapshot?.latestVersion ?? null;
  const historyVersions = historyQuery.data?.versions ?? [];

  useEffect(() => {
    const activeTurn = snapshot?.activeTurn ?? null;
    if (!activeTurn) {
      setActiveTurnId((current) => (current && !startTurnMutation.isPending ? null : current));
      return;
    }

    if (activeTurn.status === "running") {
      setActiveTurnId(activeTurn.turnId);
    }
    setLiveTurns((current) => upsertLiveTurn(current, activeSnapshotTurnToLiveTurn(activeTurn)));
    setThreadPreviewDismissed(false);
  }, [snapshot?.activeTurn, startTurnMutation.isPending]);

  const startTurn = useCallback(async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt && panelImages.length === 0) {
      return;
    }
    const promptForSend =
      trimmedPrompt || "Use the attached image(s) as reference and update the organization panel.";
    const imagesSnapshot = [...panelImages];
    setPendingPrompt(promptForSend);
    setThreadPreviewDismissed(false);
    setComposerCollapsed(false);
    setPanelAttachmentError(null);
    try {
      const attachments = await Promise.all(
        imagesSnapshot.map(async (image) => ({
          type: "image" as const,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl: await readFileAsDataUrl(image.file),
        })),
      );
      await startTurnMutation.mutateAsync({ prompt: promptForSend, attachments });
    } catch (error) {
      setPanelAttachmentError(errorMessage(error));
      setPendingPrompt(null);
    }
  }, [panelImages, prompt, startTurnMutation]);

  const addPanelImages = useCallback((files: readonly File[]) => {
    if (files.length === 0) {
      return;
    }
    setPanelImages((current) => {
      const nextImages: PanelComposerImageAttachment[] = [];
      let nextImageCount = current.length;
      let error: string | null = null;

      for (const file of files) {
        if (!file.type.startsWith("image/")) {
          error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
          continue;
        }
        if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
          error = `'${file.name}' exceeds the ${PANEL_IMAGE_SIZE_LIMIT_LABEL} attachment limit.`;
          continue;
        }
        if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
          error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
          break;
        }
        nextImages.push({
          type: "image",
          id: randomUUID(),
          name: file.name || "image",
          mimeType: file.type,
          sizeBytes: file.size,
          previewUrl: URL.createObjectURL(file),
          file,
        });
        nextImageCount += 1;
      }

      setPanelAttachmentError(error);
      return nextImages.length > 0 ? [...current, ...nextImages] : current;
    });
  }, []);

  const removePanelImage = useCallback((imageId: string) => {
    setPanelImages((current) => {
      const removed = current.find((image) => image.id === imageId);
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return current.filter((image) => image.id !== imageId);
    });
  }, []);

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

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <ScrollArea className="min-h-0 flex-1">
            <main
              className={cn(
                "mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 pt-5 sm:px-6",
                composerCollapsed ? "pb-24" : "pb-52",
              )}
            >
              {panelQuery.error ? (
                <Alert variant="error" className="rounded-lg">
                  <AlertTitle>Organization panel unavailable</AlertTitle>
                  <AlertDescription>{errorMessage(panelQuery.error)}</AlertDescription>
                </Alert>
              ) : null}

              {snapshot ? (
                <section className="min-h-[28rem] min-w-0 overflow-hidden rounded-lg border border-border bg-background">
                  <OrganizationPanelHost snapshot={snapshot} />
                </section>
              ) : !panelQuery.error ? (
                <div className="text-sm text-muted-foreground">Loading organization panel...</div>
              ) : null}
            </main>
          </ScrollArea>

          {snapshot ? (
            <OrganizationPanelControls
              snapshot={snapshot}
              prompt={prompt}
              setPrompt={(nextPrompt) => {
                setPrompt(nextPrompt);
                if (nextPrompt.trim().length > 0) {
                  setThreadPreviewDismissed(false);
                }
              }}
              images={panelImages}
              attachmentError={panelAttachmentError}
              pendingPrompt={pendingPrompt}
              liveTurns={liveTurns}
              historyVersions={historyVersions}
              canSubmit={canSubmit}
              activeTurnId={activeTurnId}
              startPending={startTurnMutation.isPending}
              stopPending={stopTurnMutation.isPending}
              latestVersion={latestVersion}
              rollbackPending={rollbackMutation.isPending}
              composerCollapsed={composerCollapsed}
              threadPreviewDismissed={threadPreviewDismissed}
              panelChatClearedAt={panelChatClearedAt}
              startTurn={startTurn}
              stopTurn={(turnId) => void stopTurnMutation.mutateAsync(turnId)}
              rollback={(version) => void rollbackMutation.mutateAsync(version)}
              addImages={addPanelImages}
              removeImage={removePanelImage}
              toggleComposer={() => setComposerCollapsed((collapsed) => !collapsed)}
              dismissThreadPreview={() => setThreadPreviewDismissed(true)}
              clearChat={() => {
                setPanelChatClearedAt(Date.now());
                setLiveTurns([]);
                setPendingPrompt(null);
                setThreadPreviewDismissed(true);
              }}
            />
          ) : null}
        </div>
      </div>
    </SidebarInset>
  );
}

function OrganizationPanelControls(props: {
  readonly snapshot: OrganizationPanelSnapshot;
  readonly prompt: string;
  readonly setPrompt: (prompt: string) => void;
  readonly images: readonly PanelComposerImageAttachment[];
  readonly attachmentError: string | null;
  readonly pendingPrompt: string | null;
  readonly liveTurns: readonly OrganizationPanelLiveTurn[];
  readonly historyVersions: readonly OrganizationPanelVersion[];
  readonly canSubmit: boolean;
  readonly activeTurnId: OrganizationPanelTurnId | null;
  readonly startPending: boolean;
  readonly stopPending: boolean;
  readonly latestVersion: OrganizationPanelVersion | null;
  readonly rollbackPending: boolean;
  readonly composerCollapsed: boolean;
  readonly threadPreviewDismissed: boolean;
  readonly panelChatClearedAt: number | null;
  readonly startTurn: () => void;
  readonly stopTurn: (turnId: OrganizationPanelTurnId) => void;
  readonly rollback: (version: OrganizationPanelVersion) => void;
  readonly addImages: (files: readonly File[]) => void;
  readonly removeImage: (imageId: string) => void;
  readonly toggleComposer: () => void;
  readonly dismissThreadPreview: () => void;
  readonly clearChat: () => void;
}) {
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const [composerCursor, setComposerCursor] = useState(0);
  const submitDisabled = !props.canSubmit;
  const isRunning = props.activeTurnId !== null;
  const turns = useMemo(
    () =>
      buildConversationTurns({
        pendingPrompt: props.pendingPrompt,
        liveTurns: props.liveTurns,
        historyVersions: props.historyVersions,
        clearedAt: props.panelChatClearedAt,
      }),
    [props.historyVersions, props.liveTurns, props.panelChatClearedAt, props.pendingPrompt],
  );
  const placeholder =
    props.latestVersion || turns.length > 0
      ? "Ask for another panel change."
      : "Describe what this organization panel should show.";
  const latestTurn = turns[0] ?? null;
  const latestTurnNeedsAttention =
    latestTurn?.status === "pending" ||
    latestTurn?.status === "running" ||
    latestTurn?.status === "failed";
  const promptHasText = props.prompt.trim().length > 0;
  const hasImages = props.images.length > 0;
  const hasVisiblePanelChat = turns.length > 0;
  const showThreadPreview =
    Boolean(latestTurn) &&
    (promptHasText ||
      props.pendingPrompt !== null ||
      hasImages ||
      isRunning ||
      (latestTurnNeedsAttention && !props.threadPreviewDismissed));

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

  const onComposerPaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      const files = Array.from(event.clipboardData.files);
      if (files.length === 0) {
        return;
      }
      const imageFiles = files.filter((file) => file.type.startsWith("image/"));
      if (imageFiles.length === 0) {
        return;
      }
      event.preventDefault();
      props.addImages(imageFiles);
    },
    [props],
  );

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 px-3 sm:px-5">
      <div className="pointer-events-auto mx-auto flex w-full max-w-3xl flex-col gap-2">
        {showThreadPreview && latestTurn ? (
          <OrganizationPanelMiniThread
            turn={latestTurn}
            isRunning={isRunning}
            onDismiss={props.dismissThreadPreview}
          />
        ) : null}

        <form
          onSubmit={submitPrompt}
          className="overflow-hidden rounded-2xl border border-border bg-card/95 shadow-2xl shadow-background/60 backdrop-blur-xl transition-colors duration-200 has-focus-visible:border-ring/45"
        >
          <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
            <div className="-m-1 flex min-w-0 flex-1 items-center gap-2 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <span className="min-w-0 truncate rounded-full border border-border/60 bg-background/55 px-2.5 py-1 text-xs font-medium text-foreground">
                {props.snapshot.organization.name}
              </span>
              <Separator orientation="vertical" className="hidden h-4 sm:block" />
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {props.snapshot.panel.panelFilePath}
              </span>
              {hasImages ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/60 bg-background/55 px-2 py-1 text-xs font-medium text-muted-foreground">
                  <ImageIcon className="size-3" />
                  {props.images.length}
                </span>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {isRunning ? (
                <Badge variant="info" size="sm" className="hidden gap-1 sm:inline-flex">
                  <span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" />
                  Running
                </Badge>
              ) : null}

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

              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex">
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="rounded-full text-muted-foreground hover:text-foreground"
                        disabled={!hasVisiblePanelChat || isRunning || props.pendingPrompt !== null}
                        aria-label="Clear panel chat"
                        onClick={props.clearChat}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    </span>
                  }
                />
                <TooltipPopup side="top" align="end">
                  Clear panel chat
                </TooltipPopup>
              </Tooltip>

              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 rounded-full px-2 text-xs text-muted-foreground hover:text-foreground"
                aria-expanded={!props.composerCollapsed}
                onClick={props.toggleComposer}
              >
                <ChevronDownIcon
                  className={cn(
                    "size-3.5 transition-transform",
                    props.composerCollapsed && "rotate-180",
                  )}
                />
                {props.composerCollapsed ? "Open" : "Collapse"}
              </Button>
            </div>
          </div>

          {!props.composerCollapsed ? (
            <>
              <div className="relative px-3 pb-2 pt-3.5 sm:px-4 sm:pt-4">
                {props.images.length > 0 ? (
                  <div className="mb-3 flex min-w-0 flex-wrap gap-2">
                    {props.images.map((image) => (
                      <div
                        key={image.id}
                        className="relative size-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                      >
                        <img
                          src={image.previewUrl}
                          alt={image.name}
                          className="h-full w-full object-cover"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                          aria-label={`Remove ${image.name}`}
                          onClick={() => props.removeImage(image.id)}
                        >
                          <XIcon className="size-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : null}

                <ComposerPromptEditor
                  editorRef={editorRef}
                  value={props.prompt}
                  cursor={composerCursor}
                  terminalContexts={[]}
                  skills={[]}
                  className="max-h-32 [min-height:3rem]"
                  disabled={props.startPending}
                  placeholder={placeholder}
                  onRemoveTerminalContext={() => {}}
                  onPaste={onComposerPaste}
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
                {props.attachmentError ? (
                  <p className="mt-2 text-xs text-destructive">{props.attachmentError}</p>
                ) : null}
              </div>

              <div className="flex min-w-0 flex-nowrap items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
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
            </>
          ) : null}
        </form>
      </div>
    </div>
  );
}

function OrganizationPanelMiniThread(props: {
  readonly turn: OrganizationPanelConversationTurn;
  readonly isRunning: boolean;
  readonly onDismiss: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);
  const statusTone = conversationStatusTone(props.turn.status);
  const actionRows = visiblePanelThreadActivities(props.turn.activities).slice(-4);
  const blurMask =
    "linear-gradient(to top, black 0%, rgba(0,0,0,0.92) 34%, rgba(0,0,0,0.5) 68%, transparent 100%)";

  useEffect(() => {
    followLatestRef.current = true;
  }, [props.turn.key]);

  useEffect(() => {
    if (!followLatestRef.current) {
      return;
    }

    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      scrollElement.scrollTop = scrollElement.scrollHeight;
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    actionRows.length,
    props.turn.activities.length,
    props.turn.attachments.length,
    props.turn.filePath,
    props.turn.key,
    props.turn.prompt,
    props.turn.status,
  ]);

  const onThreadScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    followLatestRef.current = distanceFromBottom < 24;
  }, []);

  return (
    <section className="relative max-h-72 min-w-0 overflow-visible">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-full rounded-2xl bg-background/[0.03] backdrop-blur-xl"
        style={{
          WebkitMaskImage: blurMask,
          maskImage: blurMask,
        }}
      />
      <div className="absolute right-0 top-0 z-10">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 rounded-full bg-background/45 px-2 text-xs text-muted-foreground backdrop-blur hover:bg-background/70 hover:text-foreground"
          onClick={props.onDismiss}
        >
          Dismiss
        </Button>
      </div>

      <div
        ref={scrollRef}
        className="relative z-10 max-h-56 min-h-0 overflow-y-auto px-1 pb-1 pt-8 [scrollbar-width:thin]"
        onScroll={onThreadScroll}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex justify-end">
            <div className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
              {props.turn.attachments.length > 0 ? (
                <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
                  {props.turn.attachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                    >
                      <img
                        src={`/attachments/${encodeURIComponent(attachment.id)}`}
                        alt={attachment.name}
                        className="block h-auto max-h-[140px] w-full object-cover"
                      />
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
                {props.turn.prompt}
              </div>
            </div>
          </div>

          <div className="min-w-0 px-1 py-0.5">
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground [text-shadow:0_1px_2px_rgb(0_0_0/.4)]">
              {agentMessageForTurn(props.turn)}
            </p>
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2 text-[10px] text-muted-foreground/45">
              {props.turn.createdAt ? (
                <>
                  <span>{formatRelativeTimeLabel(props.turn.createdAt)}</span>
                  <span className="text-muted-foreground/25">•</span>
                </>
              ) : null}
              <Badge variant={statusTone.badgeVariant} size="sm" className="h-4">
                {statusTone.label}
              </Badge>
            </div>

            {actionRows.length > 0 ? (
              <div className="mt-3 px-1 py-1">
                <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
                  <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
                    Work log
                  </p>
                </div>
                <div className="space-y-0.5">
                  {actionRows.map((activity) => (
                    <div
                      key={activity.id}
                      className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-xs text-muted-foreground"
                    >
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          activityDotClassName(activity.tone),
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">{activity.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : props.isRunning ? (
              <div className="mt-3 px-1 py-1">
                <div className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-xs text-muted-foreground">
                  <span className="size-1.5 shrink-0 rounded-full bg-blue-400 motion-safe:animate-pulse" />
                  <span className="min-w-0 flex-1 truncate">Working on the panel</span>
                </div>
              </div>
            ) : null}

            {props.turn.filePath ? (
              <div className="mt-2 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                <ChevronRightIcon className="size-3 shrink-0" />
                <span className="min-w-0 truncate">{props.turn.filePath}</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
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

type OrganizationPanelTurnStatus = "pending" | "running" | "completed" | "failed" | "rolled-back";
type OrganizationPanelActivityTone = "default" | "success" | "warning" | "error";

type PanelComposerImageAttachment = ChatAttachment & {
  readonly previewUrl: string;
  readonly file: File;
};

interface OrganizationPanelTurnActivity {
  readonly id: string;
  readonly message: string;
  readonly tone: OrganizationPanelActivityTone;
}

interface OrganizationPanelLiveTurn {
  readonly turnId: OrganizationPanelTurnId;
  readonly prompt: string;
  readonly status: OrganizationPanelTurnStatus;
  readonly createdAt: string;
  readonly filePath: string | null;
  readonly attachments: readonly ChatAttachment[];
  readonly activities: readonly OrganizationPanelTurnActivity[];
}

interface OrganizationPanelConversationTurn {
  readonly key: string;
  readonly prompt: string;
  readonly status: OrganizationPanelTurnStatus;
  readonly createdAt: string | null;
  readonly filePath: string | null;
  readonly attachments: readonly ChatAttachment[];
  readonly activities: readonly OrganizationPanelTurnActivity[];
}

function activeSnapshotTurnToLiveTurn(
  activeTurn: OrganizationPanelActiveTurn,
): OrganizationPanelLiveTurn {
  return {
    turnId: activeTurn.turnId,
    prompt: activeTurn.prompt,
    status: activeTurn.status,
    createdAt: activeTurn.createdAt,
    filePath: activeTurn.filePath,
    attachments: activeTurn.attachments,
    activities: activeTurn.activities,
  };
}

function applyLiveTurnEvent(
  turns: readonly OrganizationPanelLiveTurn[],
  event: OrganizationPanelEvent,
): readonly OrganizationPanelLiveTurn[] {
  const now = new Date().toISOString();
  switch (event.type) {
    case "turn.started":
      return upsertLiveTurn(turns, {
        turnId: event.turnId,
        prompt: event.prompt,
        status: "running",
        createdAt: now,
        filePath: null,
        attachments: event.attachments ?? [],
        activities: [
          {
            id: `${event.turnId}:started`,
            message: "Turn started.",
            tone: "default",
          },
        ],
      });
    case "turn.delta":
      return appendLiveTurnActivity(turns, event.turnId, {
        message: event.message,
        tone: "default",
      });
    case "file.patch":
      return updateLiveTurn(turns, event.turnId, (turn) => ({
        ...turn,
        filePath: event.filePath,
        activities: appendActivity(turn.activities, {
          id: `${event.turnId}:file:${turn.activities.length}`,
          message: `Updated ${event.filePath}.`,
          tone: "success",
        }),
      }));
    case "validation.result":
      return appendLiveTurnActivity(turns, event.turnId, {
        message:
          event.status === "passed"
            ? "Panel validation passed."
            : `Panel validation failed: ${event.errors.join(" ")}`,
        tone: event.status === "passed" ? "success" : "error",
      });
    case "compile.result":
      return appendLiveTurnActivity(turns, event.turnId, {
        message:
          event.status === "passed"
            ? "Panel runtime checks passed."
            : `Panel runtime checks failed: ${event.errors.join(" ")}`,
        tone: event.status === "passed" ? "success" : "error",
      });
    case "turn.completed":
      return updateLiveTurn(turns, event.turnId, (turn) => ({
        ...turn,
        status: "completed",
        activities: appendActivity(turn.activities, {
          id: `${event.turnId}:completed`,
          message: "Panel updated.",
          tone: "success",
        }),
      }));
    case "turn.failed":
      return updateLiveTurn(turns, event.turnId, (turn) => ({
        ...turn,
        status: "failed",
        activities: appendActivity(turn.activities, {
          id: `${event.turnId}:failed`,
          message: event.reason,
          tone: "error",
        }),
      }));
    default:
      return turns;
  }
}

function upsertLiveTurn(
  turns: readonly OrganizationPanelLiveTurn[],
  nextTurn: OrganizationPanelLiveTurn,
): readonly OrganizationPanelLiveTurn[] {
  const existingIndex = turns.findIndex((turn) => turn.turnId === nextTurn.turnId);
  if (existingIndex === -1) {
    return [nextTurn, ...turns].slice(0, 12);
  }
  return turns.map((turn, index) => (index === existingIndex ? nextTurn : turn));
}

function updateLiveTurn(
  turns: readonly OrganizationPanelLiveTurn[],
  turnId: OrganizationPanelTurnId,
  update: (turn: OrganizationPanelLiveTurn) => OrganizationPanelLiveTurn,
): readonly OrganizationPanelLiveTurn[] {
  return turns.map((turn) => (turn.turnId === turnId ? update(turn) : turn));
}

function appendLiveTurnActivity(
  turns: readonly OrganizationPanelLiveTurn[],
  turnId: OrganizationPanelTurnId,
  activity: Omit<OrganizationPanelTurnActivity, "id">,
): readonly OrganizationPanelLiveTurn[] {
  return updateLiveTurn(turns, turnId, (turn) => ({
    ...turn,
    activities: appendActivity(turn.activities, {
      id: `${turnId}:activity:${turn.activities.length}`,
      ...activity,
    }),
  }));
}

function appendActivity(
  activities: readonly OrganizationPanelTurnActivity[],
  activity: OrganizationPanelTurnActivity,
): readonly OrganizationPanelTurnActivity[] {
  const previous = activities.at(-1);
  if (previous?.message === activity.message && previous.tone === activity.tone) {
    return activities;
  }
  return [...activities, activity].slice(-8);
}

function visiblePanelThreadActivities(
  activities: readonly OrganizationPanelTurnActivity[],
): readonly OrganizationPanelTurnActivity[] {
  const hiddenMessages = new Set([
    "agent session started.",
    "assistant message",
    "ran command",
    "reasoning",
    "sending prompt to the panel agent.",
    "starting organization panel agent.",
    "turn started.",
  ]);
  return activities.filter(
    (activity) => !hiddenMessages.has(activity.message.trim().toLowerCase()),
  );
}

function buildConversationTurns(input: {
  readonly pendingPrompt: string | null;
  readonly liveTurns: readonly OrganizationPanelLiveTurn[];
  readonly historyVersions: readonly OrganizationPanelVersion[];
  readonly clearedAt: number | null;
}): readonly OrganizationPanelConversationTurn[] {
  const liveTurnIds = new Set(input.liveTurns.map((turn) => turn.turnId));
  const pendingTurns: OrganizationPanelConversationTurn[] = input.pendingPrompt
    ? [
        {
          key: "pending",
          prompt: input.pendingPrompt,
          status: "pending",
          createdAt: null,
          filePath: null,
          attachments: [],
          activities: [
            {
              id: "pending:sending",
              message: "Sending prompt to the panel agent.",
              tone: "default",
            },
          ],
        },
      ]
    : [];
  const liveTurns = input.liveTurns
    .filter((turn) => isAfterClearedAt(turn.createdAt, input.clearedAt))
    .map(
      (turn): OrganizationPanelConversationTurn => ({
        key: `live:${turn.turnId}`,
        prompt: turn.prompt,
        status: turn.status,
        createdAt: turn.createdAt,
        filePath: turn.filePath,
        attachments: turn.attachments,
        activities: turn.activities,
      }),
    );
  const historyTurns = input.historyVersions
    .filter(
      (version) =>
        !liveTurnIds.has(version.turnId) && isAfterClearedAt(version.createdAt, input.clearedAt),
    )
    .map(
      (version): OrganizationPanelConversationTurn => ({
        key: `history:${version.id}`,
        prompt: version.prompt,
        status: version.status === "applied" ? "completed" : "rolled-back",
        createdAt: version.createdAt,
        filePath: version.filePath,
        attachments: [],
        activities: [
          {
            id: `${version.id}:history`,
            message:
              version.status === "applied"
                ? "Panel version applied."
                : "Panel version rolled back.",
            tone: version.status === "applied" ? "success" : "warning",
          },
        ],
      }),
    );

  return [...pendingTurns, ...liveTurns, ...historyTurns].slice(0, 12);
}

function isAfterClearedAt(isoDate: string, clearedAt: number | null): boolean {
  if (clearedAt === null) {
    return true;
  }
  return new Date(isoDate).getTime() > clearedAt;
}

function revokePanelComposerImageUrls(images: readonly PanelComposerImageAttachment[]): void {
  for (const image of images) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

function conversationStatusTone(status: OrganizationPanelTurnStatus): {
  readonly label: string;
  readonly badgeVariant: "outline" | "info" | "success" | "error" | "warning";
} {
  switch (status) {
    case "pending":
      return {
        label: "Sending",
        badgeVariant: "outline",
      };
    case "running":
      return {
        label: "Running",
        badgeVariant: "info",
      };
    case "completed":
      return {
        label: "Done",
        badgeVariant: "success",
      };
    case "failed":
      return {
        label: "Needs attention",
        badgeVariant: "error",
      };
    case "rolled-back":
      return {
        label: "Rolled back",
        badgeVariant: "warning",
      };
  }
}

function agentMessageForTurn(turn: OrganizationPanelConversationTurn): string {
  switch (turn.status) {
    case "pending":
      return "I’m sending this to the organization panel agent.";
    case "running":
      return "I’m applying that change to the organization panel.";
    case "completed":
      return "I updated the organization panel.";
    case "failed":
      return "I couldn’t complete that panel update.";
    case "rolled-back":
      return "That panel version was rolled back.";
  }
}

function activityDotClassName(tone: OrganizationPanelActivityTone): string {
  switch (tone) {
    case "success":
      return "bg-success-foreground";
    case "warning":
      return "bg-warning-foreground";
    case "error":
      return "bg-destructive";
    case "default":
      return "bg-muted-foreground";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
