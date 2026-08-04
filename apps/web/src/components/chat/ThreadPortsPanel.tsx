import type { EnvironmentId, ProjectScript, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ThreadEndpoint } from "@t3tools/shared/threadEndpoints";
import { ChevronDownIcon, CopyIcon, ExternalLinkIcon, Globe2Icon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { resolveEndpointReachability } from "~/browser/browserTargetResolver";
import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { faviconUrlForOrigin } from "~/lib/favicon";
import { cn } from "~/lib/utils";
import { ensureLocalApi } from "~/localApi";
import { useThreadEndpoints } from "~/portDiscoveryState";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openPreviewSession } from "../preview/openPreviewSession";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_SECONDARY_CLASS,
  THREAD_DETAILS_PANEL_MENU_POPUP_CLASS,
} from "./threadDetailsPanelStyles";

/**
 * Mirrors the automations section's dot vocabulary so the two read as one
 * system: pulsing sky means "working on it", solid emerald means "ready".
 */
const STATUS_DOT_CLASS: Record<ThreadEndpoint["status"], string> = {
  starting: "animate-pulse bg-sky-500",
  live: "bg-emerald-500",
  stale: "bg-muted-foreground/40",
  idle: "bg-muted-foreground/30",
};

const STATUS_LABEL: Record<ThreadEndpoint["status"], string> = {
  starting: "Starting",
  live: "Running",
  stale: "No longer responding",
  idle: "Not running",
};

/** Rows beyond this collapse; a docker-compose stack can bring up a dozen. */
const VISIBLE_ENDPOINT_LIMIT = 4;

const EMPTY_PINNED_URLS: ReadonlyArray<string> = Object.freeze([]);

function EndpointFavicon({ url }: { readonly url: string }) {
  const faviconUrl = faviconUrlForOrigin(url, 32);
  // A lookup that fails still owes the row an icon; without this the broken
  // image renders as an empty box where every sibling row has a glyph.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!faviconUrl || failedUrl === faviconUrl) {
    return <Globe2Icon className={THREAD_DETAILS_PANEL_ICON_CLASS} />;
  }
  return (
    <img
      src={faviconUrl}
      alt=""
      aria-hidden
      draggable={false}
      className="-mx-0.5 size-4 shrink-0 rounded-sm"
      onError={() => setFailedUrl(faviconUrl)}
    />
  );
}

/**
 * Display label for an endpoint. Keeps the base path (a server on `/app` is a
 * different destination from one on `/`) but never the query, which is where
 * Jupyter-style access tokens live.
 */
function endpointLabel(endpoint: ThreadEndpoint): string {
  try {
    const parsed = new URL(endpoint.url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.host}${path}`;
  } catch {
    return `${endpoint.host}:${endpoint.port}`;
  }
}

function endpointDetail(
  endpoint: ThreadEndpoint,
  scripts: ReadonlyArray<ProjectScript> | undefined,
): string {
  const script = scripts?.find((candidate) => candidate.id === endpoint.scriptId);
  const parts = [script?.name, endpoint.processName].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : STATUS_LABEL[endpoint.status];
}

/**
 * Thread details panel section listing the dev servers this thread is running.
 *
 * Fed by two independent signals — URLs the process announced in its output and
 * sockets the server sees listening — so a row appears the moment a server
 * starts and disappears when it actually stops. Renders nothing when the thread
 * is not serving anything, which is most threads most of the time.
 *
 * The exception is `previewUrl` from the project's `t3.json`: that row is
 * pinned to the top and stays listed even with nothing running, so a project
 * can hand everyone who opens it the same one-click preview.
 */
export function ThreadPortsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadRef: ScopedThreadRef;
  readonly scripts: ReadonlyArray<ProjectScript> | undefined;
  /** `previewUrl` from the project's checked-in `t3.json`, if it declares one. */
  readonly pinnedPreviewUrl?: string | null | undefined;
  readonly openPreview: OpenPreviewMutation<unknown>;
}) {
  const declaredUrls = useMemo(
    () =>
      (props.scripts ?? [])
        .map((script) => script.previewUrl)
        .filter((url): url is string => typeof url === "string" && url.trim().length > 0),
    [props.scripts],
  );

  const pinnedUrls = useMemo(
    () =>
      typeof props.pinnedPreviewUrl === "string" && props.pinnedPreviewUrl.trim().length > 0
        ? [props.pinnedPreviewUrl]
        : EMPTY_PINNED_URLS,
    [props.pinnedPreviewUrl],
  );

  const endpoints = useThreadEndpoints({
    environmentId: props.environmentId,
    threadId: props.threadId,
    declaredUrls,
    pinnedUrls,
  });

  const reportFailure = useCallback((title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  }, []);

  const openEndpoint = useCallback(
    async (endpoint: ThreadEndpoint) => {
      const reachability = resolveEndpointReachability(props.environmentId, endpoint.url);
      if (reachability.kind === "unreachable") {
        reportFailure("Cannot open this port", new Error(reachability.reason));
        return;
      }
      // Only the desktop build has a browser surface. Everywhere else a new
      // tab is the honest fallback — better than a row that does nothing.
      if (!isPreviewSupportedInRuntime()) {
        window.open(reachability.url, "_blank", "noopener,noreferrer");
        return;
      }
      const result = await openPreviewSession({
        openPreview: props.openPreview,
        threadRef: props.threadRef,
        url: reachability.url,
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportFailure("Could not open preview", squashAtomCommandFailure(result));
        }
        return;
      }
      useRightPanelStore.getState().openBrowser(props.threadRef, result.value.tabId);
    },
    [props.environmentId, props.openPreview, props.threadRef, reportFailure],
  );

  const copyUrl = useCallback(
    async (endpoint: ThreadEndpoint) => {
      try {
        await writeTextToClipboard(endpoint.url, "port URL");
      } catch (error) {
        reportFailure("Could not copy URL", error);
      }
    },
    [reportFailure],
  );

  const openExternally = useCallback(
    async (endpoint: ThreadEndpoint) => {
      const reachability = resolveEndpointReachability(props.environmentId, endpoint.url);
      if (reachability.kind === "unreachable") {
        reportFailure("Cannot open this port", new Error(reachability.reason));
        return;
      }
      // Already falls back to window.open outside the desktop shell.
      await ensureLocalApi().shell.openExternal(reachability.url);
    },
    [props.environmentId, reportFailure],
  );

  if (endpoints.length === 0) return null;

  return (
    <section
      aria-labelledby="thread-details-ports-heading"
      className="border-t border-border/65 px-2 pb-2.5 pt-2"
      data-thread-ports-panel
    >
      <div className="mb-1 flex min-h-8 items-center px-2">
        <h3
          id="thread-details-ports-heading"
          className="text-[11px] font-medium text-muted-foreground"
        >
          Ports
        </h3>
      </div>

      <ul className="m-0 list-none p-0">
        {endpoints.slice(0, VISIBLE_ENDPOINT_LIMIT).map((endpoint) => (
          <EndpointRow
            key={endpoint.key}
            endpoint={endpoint}
            environmentId={props.environmentId}
            scripts={props.scripts}
            onOpen={openEndpoint}
            onCopy={copyUrl}
            onOpenExternally={openExternally}
          />
        ))}
      </ul>

      {endpoints.length > VISIBLE_ENDPOINT_LIMIT ? (
        <p className="px-2.5 pt-1 text-[11px] text-muted-foreground">
          {`+${endpoints.length - VISIBLE_ENDPOINT_LIMIT} more`}
        </p>
      ) : null}
    </section>
  );
}

function EndpointRow(props: {
  readonly endpoint: ThreadEndpoint;
  readonly environmentId: EnvironmentId;
  readonly scripts: ReadonlyArray<ProjectScript> | undefined;
  readonly onOpen: (endpoint: ThreadEndpoint) => Promise<void>;
  readonly onCopy: (endpoint: ThreadEndpoint) => Promise<void>;
  readonly onOpenExternally: (endpoint: ThreadEndpoint) => Promise<void>;
}) {
  const anchorRef = useRef<HTMLLIElement>(null);
  const { endpoint } = props;
  const label = endpointLabel(endpoint);
  const detail = endpointDetail(endpoint, props.scripts);
  // Resolved per render so a reconnect to a differently-reachable environment
  // updates the row without any extra plumbing.
  const reachability = resolveEndpointReachability(props.environmentId, endpoint.url);
  const unreachable = reachability.kind === "unreachable";

  return (
    <li ref={anchorRef} className={THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS}
              disabled={unreachable}
              // `label` rather than the raw URL: a Jupyter-style access token
              // lives in the query string, and must not surface in accessible
              // or hover text just because it is needed in the href.
              aria-label={`Open ${label}`}
              onClick={() => void props.onOpen(endpoint)}
            />
          }
        >
          <EndpointFavicon url={endpoint.url} />
          <span className="flex min-w-0 flex-1 flex-col items-start">
            <span className="flex w-full min-w-0 items-center gap-1.5">
              <span
                className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASS[endpoint.status])}
                aria-hidden
              />
              <span className="truncate">{label}</span>
            </span>
            <span className="w-full truncate text-[11px] font-normal text-muted-foreground">
              {detail}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {unreachable ? reachability.reason : `${STATUS_LABEL[endpoint.status]} · ${label}`}
        </TooltipPopup>
      </Tooltip>
      <Menu highlightItemOnHover={false}>
        <MenuTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className={THREAD_DETAILS_PANEL_LINK_SPLIT_SECONDARY_CLASS}
              aria-label={`Actions for ${label}`}
            />
          }
        >
          <ChevronDownIcon className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
        </MenuTrigger>
        <MenuPopup align="end" className={THREAD_DETAILS_PANEL_MENU_POPUP_CLASS}>
          <MenuItem onClick={() => void props.onCopy(endpoint)}>
            <CopyIcon className="size-4" />
            <span>Copy URL</span>
          </MenuItem>
          <MenuItem disabled={unreachable} onClick={() => void props.onOpenExternally(endpoint)}>
            <ExternalLinkIcon className="size-4" />
            <span>Open in browser</span>
          </MenuItem>
        </MenuPopup>
      </Menu>
    </li>
  );
}
