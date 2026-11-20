import { useAtomValue } from "@effect/atom-react";
import {
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isLoopbackHost } from "@t3tools/shared/preview";
import {
  CableIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  SquareIcon,
} from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";

import {
  resolveExternalServerUrl,
  tunnelsEnvironmentLoopback,
} from "~/browser/browserTargetResolver";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { m } from "~/i18n/messages";
import { ensureLocalApi } from "~/localApi";
import { useDiscoveredPortsState } from "~/portDiscoveryState";
import { useEnvironment } from "~/state/environments";
import {
  canForwardPorts,
  findPortForward,
  forwardedUrl,
  forwardPort,
  stopPortForward,
  useForwardLocality,
  usePortForwards,
} from "~/state/portForwards";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "../../lib/utils";
import { openDiscoveredPort } from "../preview/openDiscoveredPort";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";
import { isLoopbackPreviewUrl, threadPortRows, type ThreadPortRow } from "./threadPorts";

const PORT_PAGE_COUNT = 4;

const PORT_URL_CLIPBOARD_TARGET = {
  target: "port URL",
  unavailableMessage: msg("Clipboard API is unavailable while copying port URL."),
  failureMessage: msg("Failed to copy port URL to the clipboard."),
};

const STATUS_DOT_CLASS: Record<ThreadPortRow["status"], string> = {
  running: "bg-emerald-500",
  stopped: "bg-muted-foreground/40",
  pinned: "bg-muted-foreground/40",
};

const STATUS_LABEL: Record<ThreadPortRow["status"], string> = {
  running: msg("Running", { $context: "dev server status" }),
  stopped: msg("Not running", { $context: "dev server status" }),
  pinned: msg("Pinned", { $context: "dev server status" }),
};

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? String(error),
    }),
  );
}

/**
 * Thread details section for the dev servers this thread's terminals and agent
 * run, found by the sockets they own and the URLs they print, with the
 * project's `t3.json` `previewUrl` pinned first. Renders nothing when there is
 * nothing to list.
 */
export function ThreadPortsPanel(props: ThreadPortsPanelProps) {
  return <ThreadPortsList key={`${props.environmentId}:${props.threadId}`} {...props} />;
}

interface ThreadPortsPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly pinnedUrl: string | undefined;
}

function ThreadPortsList(props: ThreadPortsPanelProps) {
  const gt = useGT();
  const messages = useMessages();
  const configuredUrls =
    isLoopbackPreviewUrl(props.pinnedUrl) && props.pinnedUrl !== undefined
      ? [props.pinnedUrl]
      : undefined;
  // Always scans: a server the agent started outlives the turn and any terminal.
  const { servers } = useDiscoveredPortsState(props.environmentId, configuredUrls);
  const rows = threadPortRows({
    threadId: props.threadId,
    servers,
    pinnedUrl: props.pinnedUrl,
  });
  const canOperatePreview = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const canStop = useAtomValue(
    previewEnvironment.stopLocalServer.permissionAtom(props.environmentId),
  );
  const environment = useEnvironment(props.environmentId);
  const supportsStop = environment?.serverConfig?.environment.capabilities.localServerStop === true;
  const forwards = usePortForwards();
  const forwardable =
    useEnvironmentScope(props.environmentId, AuthTerminalOperateScope) &&
    environment?.connection.phase === "connected" &&
    canForwardPorts(environment);
  const locality = useForwardLocality(forwardable ? props.environmentId : null);
  const canForward = locality === "remote";
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const stopServer = useAtomCommand(previewEnvironment.stopLocalServer, {
    label: "thread server stop",
  });
  const [stoppingKey, setStoppingKey] = useState<string | null>(null);
  const [forwardingPort, setForwardingPort] = useState<number | null>(null);
  const [visibleCount, setVisibleCount] = useState(PORT_PAGE_COUNT);

  if (rows.length === 0) return null;
  const hiddenCount = Math.max(0, rows.length - visibleCount);

  const threadRef = { environmentId: props.environmentId, threadId: props.threadId };
  // Loopback means the environment's machine: a remote client reaches it at
  // the environment's LAN address instead.
  const reachableUrl = (row: ThreadPortRow) => {
    const forward = isLoopbackPreviewUrl(row.url)
      ? findPortForward(forwards, props.environmentId, portForRow(row).port)
      : undefined;
    return forward
      ? forwardedUrl(forward, row.url)
      : resolveExternalServerUrl(props.environmentId, row.url);
  };

  // This machine's browser reaches another environment's loopback only through a forward.
  // Starting a forward runs the probe; only a confirmed local environment opens directly.
  const openInBrowser = async (row: ThreadPortRow) => {
    const port = portForRow(row).port;
    // A pinned remote origin is reachable as is; only loopback needs the forward.
    const loopback = isLoopbackPreviewUrl(row.url);
    const url =
      loopback && forwardable && locality !== "local"
        ? await forwardPort(props.environmentId, port).then(
            (forward) => forwardedUrl(forward, row.url),
            (error: unknown) => {
              reportFailure(gt("Could not forward port {port}", { port }), error);
              return null;
            },
          )
        : reachableUrl(row);
    if (url === null) return;
    // Without a forward, a remote environment's localhost would open this machine's instead.
    if (
      loopback &&
      locality !== "local" &&
      tunnelsEnvironmentLoopback(environment?.entry.target) &&
      isLoopbackHost(new URL(url).hostname)
    ) {
      reportFailure(
        gt("Could not open link"),
        new Error(
          gt(
            "localhost:{port} runs on another machine, and port forwarding isn't available for it right now.",
            { port },
          ),
        ),
      );
      return;
    }
    await ensureLocalApi()
      .shell.openExternal(url)
      .catch((error: unknown) => reportFailure(gt("Could not open link"), error));
  };

  const toggleForward = async (port: number, forwarded: boolean) => {
    if (forwardingPort !== null) return;
    setForwardingPort(port);
    await (
      forwarded
        ? stopPortForward(props.environmentId, port)
        : forwardPort(props.environmentId, port)
    ).catch((error: unknown) =>
      reportFailure(gt("Could not forward port {port}", { port }), error),
    );
    setForwardingPort(null);
  };

  const openInPreview = async (row: ThreadPortRow) => {
    const result = await openDiscoveredPort({ threadRef, port: portForRow(row), openPreview });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not open preview"), squashAtomCommandFailure(result));
    }
  };

  const stop = async (row: ThreadPortRow) => {
    const pid = row.server?.pid;
    if (row.server === null || pid == null || stoppingKey !== null) return;
    setStoppingKey(row.key);
    const result = await stopServer({
      environmentId: props.environmentId,
      input: { pid, port: row.server.port },
    });
    setStoppingKey(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not stop server"), squashAtomCommandFailure(result));
    }
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-ports-heading"
      title={gt("Ports", { $context: "thread details section: dev servers and their ports" })}
      data-thread-ports-panel
    >
      <ul className="m-0 list-none p-0">
        {rows.slice(0, visibleCount).map((row, index) => {
          const serverPort = row.server?.port ?? null;
          const forward =
            serverPort === null
              ? undefined
              : findPortForward(forwards, props.environmentId, serverPort);
          const detail = [
            // First, so the narrow panel truncates the less useful parts.
            forward
              ? gt("Forwarded to :{port}", {
                  $context: "a remote dev server reachable on this machine's port",
                  port: forward.localPort,
                })
              : null,
            row.pinned ? "t3.json" : null,
            row.startedBy === "agent"
              ? gt("Agent", { $context: "who started a dev server" })
              : null,
            row.processName,
            messages(STATUS_LABEL[row.status]),
          ]
            .filter((part) => part !== null)
            .join(" · ");
          const stoppable = canStop && supportsStop && row.server?.pid != null;
          return (
            <li
              key={row.key}
              data-thread-details-server-overflow={index >= PORT_PAGE_COUNT || undefined}
              className="group flex items-center gap-1 rounded-lg"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-black/[0.035] disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-white/[0.08]"
                disabled={!canOperatePreview}
                aria-label={gt("Open {label} in preview", { label: row.label })}
                onClick={() => void openInPreview(row)}
              >
                <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
                  <GlobeIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                  <span
                    className={cn(
                      "absolute -right-1 -top-1 size-1.5 rounded-full",
                      STATUS_DOT_CLASS[row.status],
                    )}
                    aria-hidden
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground/80">
                    {row.label}
                  </span>
                  <span className="block truncate text-2xs text-muted-foreground">{detail}</span>
                </span>
              </button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ThreadDetailsControl
                      size="icon-xs"
                      variant="ghost"
                      part="icon"
                      aria-label={gt("Open {label} in browser", { label: row.label })}
                      onClick={() => void openInBrowser(row)}
                    >
                      <ExternalLinkIcon className="size-3.5" />
                    </ThreadDetailsControl>
                  }
                />
                <TooltipPopup>
                  <T>Open in browser</T>
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ThreadDetailsControl
                      size="icon-xs"
                      variant="ghost"
                      part="icon"
                      aria-label={gt("Copy {label}", { label: row.label })}
                      onClick={() =>
                        void writeTextToClipboard(
                          reachableUrl(row),
                          PORT_URL_CLIPBOARD_TARGET,
                        ).catch((error: unknown) => reportFailure(gt("Could not copy URL"), error))
                      }
                    >
                      <CopyIcon className="size-3.5" />
                    </ThreadDetailsControl>
                  }
                />
                <TooltipPopup>
                  <T>Copy URL</T>
                </TooltipPopup>
              </Tooltip>
              {canForward && serverPort !== null ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <ThreadDetailsControl
                        size="icon-xs"
                        variant="ghost"
                        part="icon"
                        aria-pressed={forward !== undefined}
                        aria-label={
                          forward
                            ? gt("Stop forwarding {label}", { label: row.label })
                            : gt("Forward {label} to this machine", { label: row.label })
                        }
                        disabled={forwardingPort !== null}
                        onClick={() => void toggleForward(serverPort, forward !== undefined)}
                      >
                        {forwardingPort === serverPort ? (
                          <Spinner aria-hidden size="xs" />
                        ) : (
                          <CableIcon
                            aria-hidden
                            className={cn("size-3.5", forward && "text-primary")}
                          />
                        )}
                      </ThreadDetailsControl>
                    }
                  />
                  <TooltipPopup>
                    {forward ? (
                      <T>
                        Forwarded to localhost:<Var>{forward.localPort}</Var> on this machine. Click
                        to stop.
                      </T>
                    ) : (
                      <T>Forward to this machine, for any app here</T>
                    )}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              {stoppable ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <ThreadDetailsControl
                        size="icon-xs"
                        variant="ghost"
                        part="icon"
                        tone="destructive"
                        aria-label={gt("Stop {label}", { label: row.label })}
                        disabled={stoppingKey !== null}
                        onClick={() => void stop(row)}
                      >
                        {stoppingKey === row.key ? (
                          <Spinner aria-hidden size="xs" />
                        ) : (
                          <SquareIcon aria-hidden className="size-3 fill-current" />
                        )}
                      </ThreadDetailsControl>
                    }
                  />
                  <TooltipPopup>
                    <T>Stop server</T>
                  </TooltipPopup>
                </Tooltip>
              ) : null}
            </li>
          );
        })}
      </ul>
      {rows.length > PORT_PAGE_COUNT ? (
        <ThreadDetailsControl
          variant="ghost"
          size="sm"
          onClick={() =>
            setVisibleCount(hiddenCount > 0 ? visibleCount + PORT_PAGE_COUNT : PORT_PAGE_COUNT)
          }
          part="row"
          tone="muted"
          className="w-full active:scale-100"
        >
          {hiddenCount > 0 ? (
            <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
          ) : (
            <ChevronUpIcon aria-hidden className="size-4 shrink-0" />
          )}
          {hiddenCount > 0 ? (
            <T>
              Show <Var>{Math.min(hiddenCount, PORT_PAGE_COUNT)}</Var> more
            </T>
          ) : (
            <T>Show less</T>
          )}
        </ThreadDetailsControl>
      ) : null}
    </ThreadDetailsSection>
  );
}

/** Opening needs only the URL; a pinned one nothing serves yet still opens. */
function portForRow(row: ThreadPortRow): DiscoveredLocalServer {
  const url = new URL(row.url);
  return {
    host: url.hostname,
    port: url.port.length > 0 ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    url: row.url,
    processName: null,
    pid: null,
    terminal: null,
  } as DiscoveredLocalServer;
}
