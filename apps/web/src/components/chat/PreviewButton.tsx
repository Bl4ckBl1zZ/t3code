import type { EnvironmentId, PreviewTarget, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon, MonitorUpIcon } from "lucide-react";
import { memo, useState } from "react";

import {
  autoPairBrowserAgent,
  isBrowserAgentExtensionUnavailableError,
} from "../../browserAgentPairing";
import {
  getEnvironmentHttpBaseUrl,
  requireEnvironmentConnection,
} from "../../environments/runtime";
import { ensureLocalApi } from "../../localApi";
import { resolveReachablePreviewUrl } from "../../previewUrls";
import {
  formatPreviewTargetUrl,
  previewTargetSourceLabel,
  type WorkspacePreviewSelection,
} from "../../previewTargets";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const PREVIEW_DEBUG_PREFIX = "[t3 preview]";

function logPreviewDebug(event: string, details: Record<string, unknown>): void {
  if (typeof console === "undefined") {
    return;
  }
  console.info(`${PREVIEW_DEBUG_PREFIX} ${event}`, details);
}

function previewErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Unknown error");
}

function previewErrorCauseMessage(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const cause = error.cause;
  if (cause instanceof Error) {
    return cause.message;
  }
  return cause === undefined ? null : String(cause);
}

function previewSetupUrlForLog(setupUrl: string): string {
  try {
    const url = new URL(setupUrl);
    if (url.hash.length > 0) {
      url.hash = "#<redacted>";
    }
    return url.toString();
  } catch {
    return "<invalid setup url>";
  }
}

export const PreviewButton = memo(function PreviewButton({
  activeProjectName,
  activeThreadEnvironmentId,
  activeThreadId,
  previewSelection,
}: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly activeThreadId: ThreadId;
  readonly previewSelection: WorkspacePreviewSelection;
}) {
  const [isOpeningPreview, setIsOpeningPreview] = useState(false);
  const environmentHttpBaseUrl = getEnvironmentHttpBaseUrl(activeThreadEnvironmentId);

  const openSetupUrl = (url: string) => {
    if (typeof window === "undefined") {
      return;
    }
    if (window.desktopBridge) {
      void ensureLocalApi().shell.openExternal(url);
      return;
    }
    const setupWindow = window.open(url, "_blank", "noopener,noreferrer");
    if (setupWindow) {
      setupWindow.opener = null;
    }
  };

  const openPreviewInBrowserAgent = (target: PreviewTarget | null) => {
    if (isOpeningPreview) return;
    if (!activeProjectName || !target) {
      return;
    }

    const devServerUrl = target.url;
    const baseDebugDetails = {
      activeProjectName,
      activeThreadEnvironmentId,
      currentWindowOrigin: typeof window !== "undefined" ? window.location.origin : null,
      environmentHttpBaseUrl,
      devServerUrl,
      previewTargetId: target.id,
      previewTargetSource: target.source,
      previewTargetStatus: target.status,
      route: "browser-agent",
    };
    logPreviewDebug("click", baseDebugDetails);

    setIsOpeningPreview(true);
    logPreviewDebug("browser-agent-flow-start", baseDebugDetails);
    void resolveReachablePreviewUrl(devServerUrl, { environmentHttpBaseUrl })
      .then(async (reachablePreviewUrl) => {
        logPreviewDebug("browser-agent-reachable-url", {
          ...baseDebugDetails,
          reachablePreviewUrl,
        });
        if (!environmentHttpBaseUrl) {
          throw new Error("Unable to resolve this environment's backend URL.");
        }
        const connection = requireEnvironmentConnection(activeThreadEnvironmentId);
        logPreviewDebug("browser-agent-pair-start", {
          ...baseDebugDetails,
          reachablePreviewUrl,
        });
        const pairing = await autoPairBrowserAgent(connection.client, {
          baseUrl: environmentHttpBaseUrl,
          allowExternalBrowserLaunch: false,
        });
        logPreviewDebug("browser-agent-pair-complete", {
          ...baseDebugDetails,
          preferredAgentId: pairing.preferredAgentId,
          preferredSessionId: pairing.preferredSessionId,
          reachablePreviewUrl,
        });
        logPreviewDebug("browser-agent-open-request", {
          ...baseDebugDetails,
          preferredAgentId: pairing.preferredAgentId,
          preferredSessionId: pairing.preferredSessionId,
          reachablePreviewUrl,
        });
        await connection.client.browserAgents.openOrFocusPreview({
          environmentId: activeThreadEnvironmentId,
          threadId: activeThreadId,
          devServerUrl: reachablePreviewUrl,
          repoName: activeProjectName,
          ...(pairing.preferredAgentId ? { preferredAgentId: pairing.preferredAgentId } : {}),
          ...(pairing.preferredSessionId ? { preferredSessionId: pairing.preferredSessionId } : {}),
        });
        logPreviewDebug("browser-agent-open-complete", {
          ...baseDebugDetails,
          preferredAgentId: pairing.preferredAgentId,
          preferredSessionId: pairing.preferredSessionId,
          reachablePreviewUrl,
        });
      })
      .catch((error) => {
        if (isBrowserAgentExtensionUnavailableError(error)) {
          logPreviewDebug("browser-agent-extension-unavailable", {
            ...baseDebugDetails,
            error: previewErrorMessage(error),
            cause: previewErrorCauseMessage(error),
            setupUrl: previewSetupUrlForLog(error.setupUrl),
          });
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "Connect this browser",
              description:
                "Open this T3 Code host in the browser with the extension, pair or sign in there, then retry Preview.",
              actionProps: {
                children: "Open host",
                onClick: () => openSetupUrl(error.setupUrl),
              },
            }),
          );
          return;
        }
        const description =
          error instanceof Error ? error.message : "Could not open the preview URL.";
        logPreviewDebug("browser-agent-flow-failed", {
          ...baseDebugDetails,
          error: previewErrorMessage(error),
        });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Preview failed",
            description,
          }),
        );
      })
      .finally(() => {
        setIsOpeningPreview(false);
      });
  };

  const selectedTarget = previewSelection.selectedTarget;
  const disabled =
    isOpeningPreview ||
    !activeProjectName ||
    previewSelection.kind === "starting" ||
    !selectedTarget;
  const tooltipMessage =
    previewSelection.kind === "ready" && selectedTarget
      ? `Open ${formatPreviewTargetUrl(selectedTarget)} with the browser extension.`
      : previewSelection.message;

  if (previewSelection.kind === "ambiguous") {
    return (
      <Menu highlightItemOnHover={false}>
        <MenuTrigger
          render={
            <Button
              className="shrink-0"
              size="xs"
              variant="outline"
              aria-label="Preview"
              disabled={isOpeningPreview || !activeProjectName}
            />
          }
        >
          <MonitorUpIcon className="size-3" />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            Preview
          </span>
          <ChevronDownIcon className="size-3 opacity-70" />
        </MenuTrigger>
        <MenuPopup align="end" className="w-[min(86vw,22rem)]">
          {previewSelection.targets.map((target) => (
            <MenuItem
              key={target.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 rounded-md px-3 py-2 text-left"
              onClick={() => openPreviewInBrowserAgent(target)}
            >
              <span className="min-w-0 truncate text-sm font-medium text-foreground">
                {formatPreviewTargetUrl(target)}
              </span>
              <span className="text-xs text-muted-foreground">{target.port}</span>
              <span className="col-span-2 min-w-0 truncate text-xs text-muted-foreground">
                {previewTargetSourceLabel(target.source)}
                {target.command ? ` - ${target.command}` : ""}
              </span>
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    );
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              className="shrink-0"
              size="xs"
              variant="outline"
              aria-label="Preview"
              disabled={disabled}
              onClick={() => openPreviewInBrowserAgent(selectedTarget)}
            />
          }
        >
          <MonitorUpIcon className="size-3" />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            Preview
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">{tooltipMessage}</TooltipPopup>
      </Tooltip>
    </>
  );
});
