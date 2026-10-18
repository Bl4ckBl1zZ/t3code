import {
  AuthPreviewOperateScope,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CopyIcon, ExternalLinkIcon, GlobeIcon } from "lucide-react";

import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { ensureLocalApi } from "~/localApi";
import { useDiscoveredPortsState } from "~/portDiscoveryState";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentScope } from "~/state/session";
import { useThreadRunningTerminalIds } from "~/state/terminalSessions";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "../../lib/utils";
import { openDiscoveredPort } from "../preview/openDiscoveredPort";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";
import { isLoopbackPreviewUrl, threadPortRows, type ThreadPortRow } from "./threadPorts";

const STATUS_DOT_CLASS: Record<ThreadPortRow["status"], string> = {
  running: "bg-emerald-500",
  stopped: "bg-muted-foreground/40",
  pinned: "bg-muted-foreground/40",
};

const STATUS_LABEL: Record<ThreadPortRow["status"], string> = {
  running: "Running",
  stopped: "Not running",
  pinned: "Pinned",
};

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

/**
 * Thread details section for the dev servers this thread's terminals run,
 * found by the sockets they own and the URLs they print, with the project's
 * `t3.json` `previewUrl` pinned first. Renders nothing when there is nothing
 * to list, and scans only while a terminal runs or a local URL is pinned.
 */
export function ThreadPortsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly pinnedUrl: string | undefined;
}) {
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const pinnedLoopback = isLoopbackPreviewUrl(props.pinnedUrl);
  const configuredUrls =
    pinnedLoopback && props.pinnedUrl !== undefined ? [props.pinnedUrl] : undefined;
  const scans = runningTerminalIds.length > 0 || pinnedLoopback;
  const { servers } = useDiscoveredPortsState(scans ? props.environmentId : null, configuredUrls);
  const rows = threadPortRows({
    threadId: props.threadId,
    servers: scans ? servers : [],
    pinnedUrl: props.pinnedUrl,
  });
  const canOperatePreview = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });

  if (rows.length === 0) return null;

  const threadRef = { environmentId: props.environmentId, threadId: props.threadId };
  // Loopback means the environment's machine: a remote client reaches it at
  // the environment's LAN address instead.
  const reachableUrl = (row: ThreadPortRow) =>
    resolveDiscoveredServerUrl(props.environmentId, row.url);

  const openInPreview = async (row: ThreadPortRow) => {
    const result = await openDiscoveredPort({ threadRef, port: portForRow(row), openPreview });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not open preview", squashAtomCommandFailure(result));
    }
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-ports-heading"
      title="Ports"
      data-thread-ports-panel
    >
      <ul className="m-0 list-none p-0">
        {rows.map((row) => {
          const detail = [row.pinned ? "t3.json" : null, row.processName, STATUS_LABEL[row.status]]
            .filter((part) => part !== null)
            .join(" · ");
          return (
            <li key={row.key} className="group flex items-center gap-1 rounded-lg">
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-black/[0.035] disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-white/[0.08]"
                disabled={!canOperatePreview}
                aria-label={`Open ${row.label} in preview`}
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
                      aria-label={`Open ${row.label} in browser`}
                      onClick={() =>
                        void ensureLocalApi()
                          .shell.openExternal(reachableUrl(row))
                          .catch((error: unknown) => reportFailure("Could not open link", error))
                      }
                    >
                      <ExternalLinkIcon className="size-3.5" />
                    </ThreadDetailsControl>
                  }
                />
                <TooltipPopup>Open in browser</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ThreadDetailsControl
                      size="icon-xs"
                      variant="ghost"
                      part="icon"
                      aria-label={`Copy ${row.label}`}
                      onClick={() =>
                        void writeTextToClipboard(reachableUrl(row), "port URL").catch(
                          (error: unknown) => reportFailure("Could not copy URL", error),
                        )
                      }
                    >
                      <CopyIcon className="size-3.5" />
                    </ThreadDetailsControl>
                  }
                />
                <TooltipPopup>Copy URL</TooltipPopup>
              </Tooltip>
            </li>
          );
        })}
      </ul>
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
