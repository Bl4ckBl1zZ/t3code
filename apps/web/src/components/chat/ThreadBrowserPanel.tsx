import type {
  BrowserAgent,
  BrowserAgentSnapshot,
  BrowserAgentStreamEvent,
  BrowserAgentThreadTabInputEvent,
  BrowserWorkspaceLink,
  EnvironmentId,
  ProjectScript,
  ThreadId,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LinkIcon,
  MonitorUpIcon,
  PauseIcon,
  PlayIcon,
  RefreshCcwIcon,
  RotateCwIcon,
  ShieldIcon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type WheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  resolveBrowserAgentPreviewUrl,
  resolveBrowserAgentReachablePreviewUrl,
} from "../../browserAgents";
import { autoPairBrowserAgent } from "../../browserAgentPairing";
import { readEnvironmentConnection } from "../../environments/runtime";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type BrowserPanelStatus =
  | "unlinked"
  | "linked"
  | "needs-tab"
  | "agent-disconnected"
  | "capture-active"
  | "capture-paused";

function applyBrowserAgentStreamEvent(
  current: BrowserAgentSnapshot | null,
  event: BrowserAgentStreamEvent,
): BrowserAgentSnapshot {
  if (event.type === "snapshot") {
    return event.snapshot;
  }
  const snapshot = current ?? {
    agents: [],
    currentSessionId: null,
    tabs: [],
    workspaceLinks: [],
  };
  switch (event.type) {
    case "agent-upserted":
      return {
        ...snapshot,
        agents: [...snapshot.agents.filter((agent) => agent.id !== event.agent.id), event.agent],
      };
    case "agent-removed":
      return {
        ...snapshot,
        agents: snapshot.agents.map((agent) =>
          agent.id === event.agentId ? { ...agent, connected: false } : agent,
        ),
      };
    case "tabs-updated":
      return {
        ...snapshot,
        tabs: [...snapshot.tabs.filter((tab) => tab.agentId !== event.agentId), ...event.tabs],
      };
    case "workspace-link-upserted":
      return {
        ...snapshot,
        workspaceLinks: [
          ...snapshot.workspaceLinks.filter((link) => link.id !== event.link.id),
          event.link,
        ],
      };
    case "workspace-link-removed":
      return {
        ...snapshot,
        workspaceLinks: snapshot.workspaceLinks.filter((link) => link.id !== event.linkId),
      };
    default:
      event satisfies never;
      return snapshot;
  }
}

function linkForThread(input: {
  readonly snapshot: BrowserAgentSnapshot | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): BrowserWorkspaceLink | null {
  return (
    input.snapshot?.workspaceLinks.find(
      (link) => link.environmentId === input.environmentId && link.threadId === input.threadId,
    ) ?? null
  );
}

function connectedAgentForLink(
  snapshot: BrowserAgentSnapshot | null,
  link: BrowserWorkspaceLink | null,
): BrowserAgent | null {
  if (!snapshot || !link) {
    return null;
  }
  return snapshot.agents.find((agent) => agent.id === link.agentId && agent.connected) ?? null;
}

function browserPanelStatus(
  link: BrowserWorkspaceLink | null,
  agent: BrowserAgent | null,
): BrowserPanelStatus {
  if (!link) {
    return "unlinked";
  }
  if (!agent) {
    return "agent-disconnected";
  }
  if (link.tabStatus === "closed") {
    return "needs-tab";
  }
  if (link.captureState === "off") {
    return "capture-paused";
  }
  if (link.captureState === "live" || link.captureState === "screenshot-fallback") {
    return "capture-active";
  }
  return "linked";
}

function statusLabel(status: BrowserPanelStatus, link: BrowserWorkspaceLink | null): string {
  switch (status) {
    case "unlinked":
      return "No browser tab linked";
    case "agent-disconnected":
      return "Browser disconnected";
    case "needs-tab":
      return "Browser tab closed";
    case "capture-active":
      return link?.captureState === "live" ? "Live" : "Screenshot fallback";
    case "capture-paused":
      return "Capture paused";
    case "linked":
      return "Linked";
  }
}

function imagePayloadDataUrl(payload: unknown): string | null {
  if (
    payload &&
    typeof payload === "object" &&
    "dataUrl" in payload &&
    typeof payload.dataUrl === "string"
  ) {
    return payload.dataUrl;
  }
  return null;
}

export const ThreadBrowserPanel = memo(function ThreadBrowserPanel({
  activeProjectName,
  activeProjectScripts,
  activeThreadEnvironmentId,
  activeThreadId,
  detectedDevServerUrl,
  projectPreviewUrl,
}: {
  readonly activeProjectName: string | undefined;
  readonly activeProjectScripts: readonly ProjectScript[] | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly activeThreadId: ThreadId;
  readonly detectedDevServerUrl: string | null;
  readonly projectPreviewUrl: string | null | undefined;
}) {
  const [snapshot, setSnapshot] = useState<BrowserAgentSnapshot | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const autoCaptureLinkIdRef = useRef<string | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const connection = readEnvironmentConnection(activeThreadEnvironmentId);
  const link = useMemo(
    () =>
      linkForThread({
        snapshot,
        environmentId: activeThreadEnvironmentId,
        threadId: activeThreadId,
      }),
    [activeThreadEnvironmentId, activeThreadId, snapshot],
  );
  const connectedAgent = useMemo(() => connectedAgentForLink(snapshot, link), [link, snapshot]);
  const connectedAgents = snapshot?.agents.filter((agent) => agent.connected) ?? [];
  const status = browserPanelStatus(link, connectedAgent);
  const devServerUrl = useMemo(
    () =>
      resolveBrowserAgentPreviewUrl({
        projectPreviewUrl,
        detectedDevServerUrl,
        scripts: activeProjectScripts,
      }),
    [activeProjectScripts, detectedDevServerUrl, projectPreviewUrl],
  );

  useEffect(() => {
    if (!connection) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    void connection.client.browserAgents
      .list()
      .then((nextSnapshot) => {
        if (!cancelled) {
          setSnapshot(nextSnapshot);
        }
      })
      .catch(() => undefined);
    const unsubscribe = connection.client.browserAgents.subscribe((event) => {
      setSnapshot((current) => applyBrowserAgentStreamEvent(current, event));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [connection]);

  useEffect(() => {
    setUrlInput(link?.url ?? link?.devServerUrl ?? devServerUrl);
  }, [devServerUrl, link?.devServerUrl, link?.url]);

  const runAction = useCallback(
    (actionName: string, action: () => Promise<void>) => {
      if (pendingAction) {
        return;
      }
      setPendingAction(actionName);
      void action()
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Browser action failed",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        })
        .finally(() => setPendingAction(null));
    },
    [pendingAction],
  );

  const pairBrowser = useCallback(() => {
    if (!connection) {
      return;
    }
    runAction("pair", async () => {
      await autoPairBrowserAgent(connection.client);
    });
  }, [connection, runAction]);

  const openAppPreview = useCallback(() => {
    if (!connection || !activeProjectName) {
      return;
    }
    runAction("open-preview", async () => {
      const reachablePreviewUrl = await resolveBrowserAgentReachablePreviewUrl(devServerUrl);
      await connection.client.browserAgents.openOrFocusThreadTab({
        environmentId: activeThreadEnvironmentId,
        threadId: activeThreadId,
        url: reachablePreviewUrl,
        repoName: activeProjectName,
        focus: true,
      });
    });
  }, [
    activeProjectName,
    activeThreadEnvironmentId,
    activeThreadId,
    connection,
    devServerUrl,
    runAction,
  ]);

  const attachCurrentTab = useCallback(() => {
    if (!connection) {
      return;
    }
    runAction("attach", async () => {
      await connection.client.browserAgents.attachActiveTab({
        environmentId: activeThreadEnvironmentId,
        threadId: activeThreadId,
        ...(activeProjectName ? { repoName: activeProjectName } : {}),
      });
    });
  }, [activeProjectName, activeThreadEnvironmentId, activeThreadId, connection, runAction]);

  const openBlankTab = useCallback(() => {
    if (!connection) {
      return;
    }
    runAction("blank", async () => {
      await connection.client.browserAgents.openOrFocusThreadTab({
        environmentId: activeThreadEnvironmentId,
        threadId: activeThreadId,
        url: "about:blank",
        repoName: activeProjectName ?? "Browser",
        focus: true,
      });
    });
  }, [activeProjectName, activeThreadEnvironmentId, activeThreadId, connection, runAction]);

  const startCapture = useCallback(() => {
    if (!connection || !link) {
      return;
    }
    runAction("capture", async () => {
      const result = await connection.client.browserAgents.startThreadTabCapture({
        environmentId: activeThreadEnvironmentId,
        threadId: activeThreadId,
        quality: {
          maxWidth: 1920,
          maxHeight: 1080,
          fps: 2,
        },
      });
      const dataUrl = imagePayloadDataUrl(result.payload);
      if (dataUrl) {
        setScreenshotDataUrl(dataUrl);
      }
    });
  }, [activeThreadEnvironmentId, activeThreadId, connection, link, runAction]);

  const stopCapture = useCallback(() => {
    if (!connection || !link) {
      return;
    }
    runAction("stop-capture", async () => {
      await connection.client.browserAgents.stopThreadTabCapture({
        environmentId: activeThreadEnvironmentId,
        threadId: activeThreadId,
      });
      setScreenshotDataUrl(null);
    });
  }, [activeThreadEnvironmentId, activeThreadId, connection, link, runAction]);

  const setAgentAccess = useCallback(
    (enabled: boolean) => {
      if (!connection || !link) {
        return;
      }
      runAction("agent-access", async () => {
        await connection.client.browserAgents.setThreadTabControl({
          environmentId: activeThreadEnvironmentId,
          threadId: activeThreadId,
          controlState: enabled ? "enabled" : "paused-by-user",
        });
      });
    },
    [activeThreadEnvironmentId, activeThreadId, connection, link, runAction],
  );

  const detach = useCallback(() => {
    if (!connection || !link) {
      return;
    }
    runAction("detach", async () => {
      await connection.client.browserAgents.detachThreadTab({
        environmentId: activeThreadEnvironmentId,
        threadId: activeThreadId,
      });
      setScreenshotDataUrl(null);
    });
  }, [activeThreadEnvironmentId, activeThreadId, connection, link, runAction]);

  const navigateToUrl = useCallback(() => {
    if (!connection || !link || !urlInput.trim()) {
      return;
    }
    runAction("navigate", async () => {
      await connection.client.browserAgents.navigateThreadTab({
        environmentId: activeThreadEnvironmentId,
        threadId: activeThreadId,
        url: urlInput.trim(),
      });
    });
  }, [activeThreadEnvironmentId, activeThreadId, connection, link, runAction, urlInput]);

  const reopenLinkedTab = useCallback(() => {
    if (!connection || !link) {
      return;
    }
    runAction("reopen", async () => {
      await connection.client.browserAgents.openOrFocusThreadTab({
        environmentId: activeThreadEnvironmentId,
        threadId: activeThreadId,
        url: link.url ?? link.devServerUrl,
        repoName: activeProjectName ?? link.repoName,
        focus: true,
      });
    });
  }, [activeProjectName, activeThreadEnvironmentId, activeThreadId, connection, link, runAction]);

  const refreshScreenshot = useCallback(async () => {
    if (!connection || !link || link.tabStatus === "closed") {
      return;
    }
    const result = await connection.client.browserAgents.screenshotThreadTab({
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
    });
    const dataUrl = imagePayloadDataUrl(result.payload);
    if (dataUrl) {
      setScreenshotDataUrl(dataUrl);
    }
  }, [activeThreadEnvironmentId, activeThreadId, connection, link]);

  const runThreadTabHistory = useCallback(
    (action: "back" | "forward" | "reload") => {
      if (!connection || !link || link.tabStatus === "closed") {
        return;
      }
      runAction(action, async () => {
        const input = {
          environmentId: activeThreadEnvironmentId,
          threadId: activeThreadId,
        };
        if (action === "back") {
          await connection.client.browserAgents.backThreadTab(input);
        } else if (action === "forward") {
          await connection.client.browserAgents.forwardThreadTab(input);
        } else {
          await connection.client.browserAgents.reloadThreadTab(input);
        }
        await refreshScreenshot();
      });
    },
    [activeThreadEnvironmentId, activeThreadId, connection, link, refreshScreenshot, runAction],
  );

  useEffect(() => {
    if (
      !connection ||
      !link ||
      link.tabId === undefined ||
      link.captureState !== "off" ||
      link.tabStatus === "closed"
    ) {
      return;
    }
    if (autoCaptureLinkIdRef.current === link.id) {
      return;
    }
    autoCaptureLinkIdRef.current = link.id;
    void connection.client.browserAgents.startThreadTabCapture({
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
      quality: {
        maxWidth: 1920,
        maxHeight: 1080,
        fps: 2,
      },
    });
  }, [activeThreadEnvironmentId, activeThreadId, connection, link]);

  useEffect(() => {
    if (!link || !["live", "screenshot-fallback"].includes(link.captureState)) {
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void refreshScreenshot().catch(() => undefined);
    };
    refresh();
    const interval = window.setInterval(() => {
      if (!cancelled) {
        refresh();
      }
    }, 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [link, refreshScreenshot]);

  const sendInput = useCallback(
    async (input: BrowserAgentThreadTabInputEvent) => {
      if (!connection || !link || link.tabStatus === "closed") {
        return;
      }
      await connection.client.browserAgents.inputThreadTab({
        environmentId: activeThreadEnvironmentId,
        threadId: activeThreadId,
        input,
      });
      await refreshScreenshot();
    },
    [activeThreadEnvironmentId, activeThreadId, connection, link, refreshScreenshot],
  );

  const handleMirrorClick = useCallback(
    (event: MouseEvent<HTMLImageElement>) => {
      const image = imageRef.current;
      if (!image) {
        return;
      }
      const rect = image.getBoundingClientRect();
      const scaleX = image.naturalWidth / rect.width;
      const scaleY = image.naturalHeight / rect.height;
      void sendInput({
        type: "click",
        x: Math.round((event.clientX - rect.left) * scaleX),
        y: Math.round((event.clientY - rect.top) * scaleY),
        button: "left",
      });
    },
    [sendInput],
  );

  const handleMirrorWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      void sendInput({
        type: "scroll",
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      });
    },
    [sendInput],
  );

  const handleMirrorKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.currentTarget.blur();
        return;
      }
      if (event.key.length > 1) {
        event.preventDefault();
        void sendInput({ type: "key", key: event.key });
      }
    },
    [sendInput],
  );

  const handleMirrorBeforeInput = useCallback(
    (event: FormEvent<HTMLDivElement>) => {
      const nativeEvent = event.nativeEvent as InputEvent;
      if (!nativeEvent.data) {
        return;
      }
      event.preventDefault();
      void sendInput({ type: "type", text: nativeEvent.data });
    },
    [sendInput],
  );

  const handleMirrorPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const text = event.clipboardData.getData("text/plain");
      if (!text) {
        return;
      }
      event.preventDefault();
      void sendInput({ type: "type", text });
    },
    [sendInput],
  );

  const agentAccessEnabled = link?.controlState === "enabled";
  const captureCanStop =
    link?.captureState === "requesting-permission" ||
    link?.captureState === "live" ||
    link?.captureState === "screenshot-fallback";

  if (!connection) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <BrowserPanelNotice
          icon={<UnplugIcon />}
          title="Environment disconnected"
          body="Reconnect this environment to use browser tabs with the thread."
        />
      </div>
    );
  }

  if (!link) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <BrowserPanelNotice
          icon={<GlobeIcon />}
          title={connectedAgents.length === 0 ? "No paired browser" : "Connect browser tab"}
          body="This uses your existing Brave profile. The agent for this thread will only control the linked tab."
          actions={
            connectedAgents.length === 0 ? (
              <Button onClick={pairBrowser} disabled={pendingAction !== null}>
                <LinkIcon />
                Pair Brave extension
              </Button>
            ) : (
              <>
                <Button
                  onClick={openAppPreview}
                  disabled={pendingAction !== null || !activeProjectName}
                >
                  <MonitorUpIcon />
                  Open app preview
                </Button>
                <Button
                  variant="outline"
                  onClick={attachCurrentTab}
                  disabled={pendingAction !== null}
                >
                  <LinkIcon />
                  Attach current Brave tab
                </Button>
                <Button variant="outline" onClick={openBlankTab} disabled={pendingAction !== null}>
                  <GlobeIcon />
                  New blank tab
                </Button>
              </>
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex min-h-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <ToolbarIconButton
          label="Back"
          disabled={pendingAction !== null || link.tabStatus === "closed"}
          onClick={() => runThreadTabHistory("back")}
        >
          <ArrowLeftIcon />
        </ToolbarIconButton>
        <ToolbarIconButton
          label="Forward"
          disabled={pendingAction !== null || link.tabStatus === "closed"}
          onClick={() => runThreadTabHistory("forward")}
        >
          <ArrowRightIcon />
        </ToolbarIconButton>
        <ToolbarIconButton
          label="Reload"
          disabled={!link.url || pendingAction !== null || link.tabStatus === "closed"}
          onClick={() => runThreadTabHistory("reload")}
        >
          <RotateCwIcon />
        </ToolbarIconButton>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            navigateToUrl();
          }}
        >
          <Input
            aria-label="Browser URL"
            nativeInput
            size="sm"
            value={urlInput}
            disabled={link.tabStatus === "closed"}
            onChange={(event) => setUrlInput(event.currentTarget.value)}
          />
        </form>
        <ToolbarIconButton
          label="Open in browser"
          disabled={pendingAction !== null || link.tabStatus === "closed"}
          onClick={() => {
            if (!connection || !link.url) return;
            runAction("focus", async () => {
              await connection.client.browserAgents.openOrFocusThreadTab({
                environmentId: activeThreadEnvironmentId,
                threadId: activeThreadId,
                url: link.url ?? link.devServerUrl,
                repoName: activeProjectName ?? link.repoName,
                focus: true,
              });
            });
          }}
        >
          <ExternalLinkIcon />
        </ToolbarIconButton>
        <ToolbarIconButton
          label={captureCanStop ? "Stop live view" : "Enable live view"}
          disabled={pendingAction !== null || link.tabStatus === "closed"}
          onClick={captureCanStop ? stopCapture : startCapture}
        >
          {captureCanStop ? <PauseIcon /> : <PlayIcon />}
        </ToolbarIconButton>
        <div className="ml-1 flex items-center gap-2 border-l border-border pl-2 text-muted-foreground text-xs">
          <ShieldIcon className="size-3.5" />
          <Switch
            aria-label="Agent access"
            checked={agentAccessEnabled}
            disabled={pendingAction !== null}
            onCheckedChange={setAgentAccess}
          />
        </div>
        <ToolbarIconButton
          label="Detach browser tab"
          disabled={pendingAction !== null}
          onClick={detach}
        >
          <XIcon />
        </ToolbarIconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-3 text-muted-foreground text-xs">
          <span className="font-medium text-foreground">{link.browserLabel}</span>
          <span aria-hidden="true">/</span>
          <span>{statusLabel(status, link)}</span>
          <span className="ml-auto">
            {agentAccessEnabled ? "Agent can control this tab" : "Agent access paused"}
          </span>
        </div>

        {status === "agent-disconnected" ? (
          <BrowserPanelNotice
            icon={<UnplugIcon />}
            title="Browser disconnected"
            body="Reconnect the Brave extension to resume live view and agent control."
            actions={
              <>
                <Button variant="outline" onClick={pairBrowser} disabled={pendingAction !== null}>
                  <LinkIcon />
                  Pair browser
                </Button>
                <Button onClick={attachCurrentTab} disabled={pendingAction !== null}>
                  <RefreshCcwIcon />
                  Retry
                </Button>
              </>
            }
          />
        ) : status === "needs-tab" ? (
          <BrowserPanelNotice
            icon={<GlobeIcon />}
            title="Browser tab closed"
            body="The agent cannot use the browser until this thread is linked to a tab again."
            actions={
              <>
                <Button onClick={reopenLinkedTab} disabled={pendingAction !== null}>
                  <MonitorUpIcon />
                  Reopen last URL
                </Button>
                <Button
                  variant="outline"
                  onClick={attachCurrentTab}
                  disabled={pendingAction !== null}
                >
                  <LinkIcon />
                  Attach another tab
                </Button>
              </>
            }
          />
        ) : (
          <div
            className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/35 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            tabIndex={0}
            onBeforeInput={handleMirrorBeforeInput}
            onKeyDown={handleMirrorKeyDown}
            onPaste={handleMirrorPaste}
            onWheel={handleMirrorWheel}
          >
            {screenshotDataUrl ? (
              <img
                ref={imageRef}
                alt="Mirrored browser tab"
                className="max-h-full max-w-full select-none bg-background shadow-sm"
                src={screenshotDataUrl}
                draggable={false}
                onClick={handleMirrorClick}
              />
            ) : (
              <BrowserPanelNotice
                icon={<MonitorUpIcon />}
                title="Live view needs permission"
                body="Brave requires a browser action before this tab can be mirrored."
                actions={
                  <Button onClick={startCapture} disabled={pendingAction !== null}>
                    <PlayIcon />
                    Enable live view
                  </Button>
                }
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
});

function BrowserPanelNotice({
  actions,
  body,
  icon,
  title,
}: {
  readonly actions?: ReactNode;
  readonly body: string;
  readonly icon: ReactNode;
  readonly title: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-center gap-4 px-6 py-8 text-center">
      <div className="flex size-10 items-center justify-center rounded-md border border-border bg-card text-muted-foreground [&_svg]:size-5">
        {icon}
      </div>
      <div className="space-y-1">
        <h2 className="font-semibold text-base text-foreground">{title}</h2>
        <p className="text-muted-foreground text-sm leading-6">{body}</p>
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

function ToolbarIconButton({
  children,
  disabled,
  label,
  onClick,
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onClick?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            className={cn("shrink-0")}
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
