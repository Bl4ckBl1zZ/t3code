import type { ProjectScript } from "@t3tools/contracts";
import { MonitorUpIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import {
  buildBrowserTransferUrl,
  inferBrowserTransferDevServerUrl,
  resolveBrowserRoutePath,
} from "../../browserTransfer";
import { selectPairingEndpoint } from "../../advertisedEndpointSelection";
import { createServerPairingCredential } from "../../environments/primary";
import { useUiStateStore } from "../../uiStateStore";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const TransferToBrowserButton = memo(function TransferToBrowserButton({
  activeProjectName,
  activeProjectScripts,
  detectedDevServerUrl,
}: {
  readonly activeProjectName: string | undefined;
  readonly activeProjectScripts: readonly ProjectScript[] | undefined;
  readonly detectedDevServerUrl: string | null;
}) {
  const [isTransferring, setIsTransferring] = useState(false);
  const defaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.defaultAdvertisedEndpointKey,
  );
  const inferredDevServerUrl = useMemo(
    () => inferBrowserTransferDevServerUrl(activeProjectScripts),
    [activeProjectScripts],
  );
  const devServerUrl = detectedDevServerUrl ?? inferredDevServerUrl;

  const transferToBrowser = () => {
    if (isTransferring) return;
    const bridge = window.desktopBridge;
    if (!bridge) {
      toastManager.add({
        type: "error",
        title: "Transfer is unavailable in this browser.",
      });
      return;
    }

    setIsTransferring(true);
    void (async () => {
      const bootstrap = bridge.getLocalEnvironmentBootstrap();
      let t3CodeBaseUrl = bootstrap?.httpBaseUrl;
      const advertisedEndpoints = await bridge.getAdvertisedEndpoints().catch(() => []);
      const advertisedEndpoint = selectPairingEndpoint(
        advertisedEndpoints,
        defaultAdvertisedEndpointKey,
      );
      t3CodeBaseUrl = advertisedEndpoint?.httpBaseUrl ?? t3CodeBaseUrl;
      if (!t3CodeBaseUrl) {
        throw new Error("Local T3 Code URL is unavailable.");
      }

      const extensionInstallPath = bridge?.getBrowserExtensionInstallPath
        ? await bridge.getBrowserExtensionInstallPath()
        : null;
      const pairingCredential = await createServerPairingCredential("Chrome browser transfer");
      const transferUrl = buildBrowserTransferUrl({
        t3CodeBaseUrl,
        routePath: resolveBrowserRoutePath(window.location),
        pairingCredential: pairingCredential.credential,
        devServerUrl,
        ...(activeProjectName ? { groupTitle: activeProjectName } : {}),
        extensionInstallPath,
      });

      const opened = bridge.openInChrome
        ? await bridge.openInChrome(transferUrl)
        : await bridge.openExternal(transferUrl);
      if (!opened) {
        throw new Error("The browser could not be opened.");
      }

      toastManager.add({
        type: "success",
        title: "Transfer sent to browser",
      });
    })()
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Transfer to browser failed",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      })
      .finally(() => {
        setIsTransferring(false);
      });
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            className="shrink-0"
            size="xs"
            variant="outline"
            aria-label="Transfer to Browser"
            disabled={isTransferring}
            onClick={transferToBrowser}
          />
        }
      >
        <MonitorUpIcon className="size-3" />
        <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
          Transfer to Browser
        </span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        Open {devServerUrl} with T3 Code in Chrome side panel.
      </TooltipPopup>
    </Tooltip>
  );
});
