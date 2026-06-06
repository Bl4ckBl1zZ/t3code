import type { EnvironmentId, ProjectScript, ThreadId } from "@t3tools/contracts";
import { MonitorUpIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import {
  autoPairBrowserAgent,
  isBrowserAgentExtensionUnavailableError,
} from "../../browserAgentPairing";
import {
  getEnvironmentHttpBaseUrl,
  requireEnvironmentConnection,
} from "../../environments/runtime";
import { ensureLocalApi } from "../../localApi";
import { resolvePreviewUrl, resolveReachablePreviewUrl } from "../../previewUrls";
import { Button } from "../ui/button";
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
  activeProjectScripts,
  projectPreviewUrl,
  activeThreadEnvironmentId,
  activeThreadId,
  detectedDevServerUrl,
}: {
  readonly activeProjectName: string | undefined;
  readonly activeProjectScripts: readonly ProjectScript[] | undefined;
  readonly projectPreviewUrl: string | null | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly activeThreadId: ThreadId;
  readonly detectedDevServerUrl: string | null;
}) {
  const [isOpeningPreview, setIsOpeningPreview] = useState(false);
  const devServerUrl = useMemo(
    () =>
      resolvePreviewUrl({
        projectPreviewUrl,
        detectedDevServerUrl,
        scripts: activeProjectScripts,
      }),
    [activeProjectScripts, detectedDevServerUrl, projectPreviewUrl],
  );
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

  const openPreviewInBrowserAgent = () => {
    if (isOpeningPreview) return;
    if (!activeProjectName) {
      return;
    }

    const baseDebugDetails = {
      activeProjectName,
      activeThreadEnvironmentId,
      currentWindowOrigin: typeof window !== "undefined" ? window.location.origin : null,
      environmentHttpBaseUrl,
      devServerUrl,
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
              title: "Browser extension needed",
              description:
                "Open the T3 Code Browser Agent setup page in this browser, then retry Preview.",
              actionProps: {
                children: "Open setup",
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
              disabled={isOpeningPreview || !activeProjectName}
              onClick={openPreviewInBrowserAgent}
            />
          }
        >
          <MonitorUpIcon className="size-3" />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            Preview
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">{`Open ${devServerUrl} with the browser extension.`}</TooltipPopup>
      </Tooltip>
    </>
  );
});
