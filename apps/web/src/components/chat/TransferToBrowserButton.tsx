import type { ProjectScript } from "@t3tools/contracts";
import { MonitorUpIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import {
  buildBrowserTransferUrl,
  inferBrowserTransferDevServerUrl,
  resolveBrowserRoutePath,
} from "../../browserTransfer";
import { createServerPairingCredential } from "../../environments/primary";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const TransferToBrowserButton = memo(function TransferToBrowserButton({
  activeProjectScripts,
}: {
  readonly activeProjectScripts: readonly ProjectScript[] | undefined;
}) {
  const [isTransferring, setIsTransferring] = useState(false);
  const devServerUrl = useMemo(
    () => inferBrowserTransferDevServerUrl(activeProjectScripts),
    [activeProjectScripts],
  );

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
      const t3CodeBaseUrl = bootstrap?.httpBaseUrl;
      if (!t3CodeBaseUrl) {
        throw new Error("Local T3 Code URL is unavailable.");
      }

      const pairingCredential = await createServerPairingCredential("Chrome browser transfer");
      const transferUrl = buildBrowserTransferUrl({
        t3CodeBaseUrl,
        routePath: resolveBrowserRoutePath(window.location),
        pairingCredential: pairingCredential.credential,
        devServerUrl,
      });

      const opened = bridge.openInChrome
        ? await bridge.openInChrome(transferUrl)
        : await bridge.openExternal(transferUrl);
      if (!opened) {
        throw new Error("Chrome could not be opened.");
      }

      toastManager.add({
        type: "success",
        title: "Transfer sent to Chrome",
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
      <TooltipPopup side="bottom">Open T3 Code and {devServerUrl} together in Chrome.</TooltipPopup>
    </Tooltip>
  );
});
