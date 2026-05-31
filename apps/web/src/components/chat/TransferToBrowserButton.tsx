import type { EnvironmentId, ProjectScript, ThreadId } from "@t3tools/contracts";
import { MonitorUpIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { inferBrowserAgentDevServerUrl } from "../../browserAgents";
import { autoPairBrowserAgent, isNoBrowserAgentConnectedError } from "../../browserAgentPairing";
import { getPrimaryEnvironmentConnection } from "../../environments/runtime";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const TransferToBrowserButton = memo(function TransferToBrowserButton({
  activeProjectName,
  activeProjectScripts,
  activeThreadEnvironmentId,
  activeThreadId,
  detectedDevServerUrl,
}: {
  readonly activeProjectName: string | undefined;
  readonly activeProjectScripts: readonly ProjectScript[] | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly activeThreadId: ThreadId;
  readonly detectedDevServerUrl: string | null;
}) {
  const [isTransferring, setIsTransferring] = useState(false);
  const inferredDevServerUrl = useMemo(
    () => inferBrowserAgentDevServerUrl(activeProjectScripts),
    [activeProjectScripts],
  );
  const devServerUrl = detectedDevServerUrl ?? inferredDevServerUrl;

  const transferToBrowser = () => {
    if (isTransferring) return;
    if (!activeProjectName) {
      return;
    }

    setIsTransferring(true);
    void (async () => {
      const connection = getPrimaryEnvironmentConnection();
      const openPreview = async () => {
        return await connection.client.browserAgents.openOrFocusPreview({
          environmentId: activeThreadEnvironmentId,
          threadId: activeThreadId,
          devServerUrl,
          repoName: activeProjectName,
        });
      };

      try {
        await openPreview();
      } catch (error) {
        if (!isNoBrowserAgentConnectedError(error)) {
          throw error;
        }

        toastManager.add({
          type: "info",
          title: "Pairing browser extension",
        });
        await autoPairBrowserAgent(connection.client);
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
            title: "Transfer to browser failed",
            description,
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
            disabled={isTransferring || !activeProjectName}
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
        Open or focus {devServerUrl} in a paired browser extension.
      </TooltipPopup>
    </Tooltip>
  );
});
