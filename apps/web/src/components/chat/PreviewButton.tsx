import type {
  AuthClientMetadataDeviceType,
  AuthSessionRole,
  EnvironmentId,
  ProjectScript,
  ServerAuthPolicy,
  ThreadId,
} from "@t3tools/contracts";
import { MonitorUpIcon, PuzzleIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import {
  resolveBrowserAgentPreviewUrl,
  resolveBrowserAgentReachablePreviewUrl,
} from "../../browserAgents";
import {
  autoPairBrowserAgent,
  isBrowserAgentExtensionUnavailableError,
  isNoBrowserAgentConnectedError,
} from "../../browserAgentPairing";
import { getPrimaryEnvironmentConnection } from "../../environments/runtime";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { shouldOpenPreviewInNewTab } from "./PreviewButton.logic";

export const PreviewButton = memo(function PreviewButton({
  activeProjectName,
  activeProjectScripts,
  projectPreviewUrl,
  activeThreadEnvironmentId,
  activeThreadId,
  detectedDevServerUrl,
  currentSessionRole,
  currentAuthPolicy,
  currentDeviceType,
}: {
  readonly activeProjectName: string | undefined;
  readonly activeProjectScripts: readonly ProjectScript[] | undefined;
  readonly projectPreviewUrl: string | null | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly activeThreadId: ThreadId;
  readonly detectedDevServerUrl: string | null;
  readonly currentSessionRole: AuthSessionRole | null;
  readonly currentAuthPolicy: ServerAuthPolicy | null;
  readonly currentDeviceType: AuthClientMetadataDeviceType | null;
}) {
  const [isOpeningPreview, setIsOpeningPreview] = useState(false);
  const [extensionDownloadUrl, setExtensionDownloadUrl] = useState<string | null>(null);
  const devServerUrl = useMemo(
    () =>
      resolveBrowserAgentPreviewUrl({
        projectPreviewUrl,
        detectedDevServerUrl,
        scripts: activeProjectScripts,
      }),
    [activeProjectScripts, detectedDevServerUrl, projectPreviewUrl],
  );
  const openPreviewInNewTab = shouldOpenPreviewInNewTab({
    currentAuthPolicy,
    currentDeviceType,
    currentSessionRole,
  });

  const openPreviewInBrowser = () => {
    if (isOpeningPreview) return;
    if (!activeProjectName) {
      return;
    }

    if (openPreviewInNewTab) {
      const previewWindow =
        typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
      setIsOpeningPreview(true);
      void resolveBrowserAgentReachablePreviewUrl(devServerUrl)
        .then((reachablePreviewUrl) => {
          if (!previewWindow) {
            const fallbackWindow =
              typeof window !== "undefined" ? window.open(reachablePreviewUrl, "_blank") : null;
            if (!fallbackWindow) {
              throw new Error("Browser blocked the preview tab.");
            }
            fallbackWindow.opener = null;
            return;
          }
          previewWindow.opener = null;
          previewWindow.location.href = reachablePreviewUrl;
        })
        .catch((error) => {
          previewWindow?.close();
          const description =
            error instanceof Error ? error.message : "Could not open the preview URL.";
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
      return;
    }

    setIsOpeningPreview(true);
    void (async () => {
      const connection = getPrimaryEnvironmentConnection();
      const openPreview = async () => {
        const reachablePreviewUrl = await resolveBrowserAgentReachablePreviewUrl(devServerUrl);
        return await connection.client.browserAgents.openOrFocusPreview({
          environmentId: activeThreadEnvironmentId,
          threadId: activeThreadId,
          devServerUrl: reachablePreviewUrl,
          repoName: activeProjectName,
        });
      };

      try {
        await openPreview();
      } catch (error) {
        if (!isNoBrowserAgentConnectedError(error)) {
          throw error;
        }

        const pairingToastId = toastManager.add({
          type: "info",
          title: "Pairing browser extension",
        });
        try {
          await autoPairBrowserAgent(connection.client);
        } catch (pairingError) {
          if (isBrowserAgentExtensionUnavailableError(pairingError)) {
            setExtensionDownloadUrl(pairingError.downloadUrl);
            return;
          }
          throw pairingError;
        } finally {
          toastManager.close(pairingToastId);
        }
        await openPreview();
      }

      toastManager.add({
        type: "success",
        title: "Preview sent to browser",
      });
    })()
      .catch((error) => {
        const description =
          error instanceof Error
            ? error.message
            : "Install or reload the T3 Code Browser Agent extension and try again.";
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
              onClick={openPreviewInBrowser}
            />
          }
        >
          <MonitorUpIcon className="size-3" />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            Preview
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {openPreviewInNewTab
            ? `Open ${devServerUrl} in a new tab.`
            : `Open or focus ${devServerUrl} in the browser extension.`}
        </TooltipPopup>
      </Tooltip>

      <Dialog
        open={extensionDownloadUrl !== null}
        onOpenChange={(open) => {
          if (!open) {
            setExtensionDownloadUrl(null);
          }
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Chrome extension needed</DialogTitle>
            <DialogDescription>
              Preview needs the T3 Code Browser Agent extension installed and up to date in this
              browser.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <p className="text-muted-foreground text-sm leading-6">
              Install the extension, or open the extension popup and click Reload extension after
              pulling a newer T3 Code build. Then retry Preview.
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExtensionDownloadUrl(null)}>
              Cancel
            </Button>
            {extensionDownloadUrl ? (
              <Button
                render={
                  <a href={extensionDownloadUrl} onClick={() => setExtensionDownloadUrl(null)} />
                }
              >
                <PuzzleIcon />
                Install Extension
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});
