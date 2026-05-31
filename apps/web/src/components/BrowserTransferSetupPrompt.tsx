import { CopyIcon, ExternalLinkIcon, PuzzleIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  BROWSER_ANNOTATION_PAGE_SOURCE,
  BROWSER_ANNOTATION_PROBE_MESSAGE,
  BROWSER_ANNOTATION_READY_MESSAGE,
  BROWSER_ANNOTATION_STATUS_MESSAGE,
  isBrowserAnnotationExtensionMessage,
} from "../browserAnnotation";
import {
  BROWSER_TRANSFER_EXTENSION_RESPONSE_TIMEOUT_MS,
  BROWSER_TRANSFER_START_MESSAGE,
  BROWSER_TRANSFER_SETUP_REQUEST_EVENT,
  clearRememberedBrowserTransferSetupRequest,
  isBrowserTransferSetupRequest,
  readRememberedBrowserTransferSetupRequest,
  rememberBrowserTransferSetupRequest,
  rememberBrowserTransferSetupRequestFromUrl,
  SOURCE_BROWSER_TRANSFER_EXTENSION_PATH,
  type BrowserTransferSetupRequest,
} from "../browserTransfer";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";

const CHROME_EXTENSIONS_URL = "chrome://extensions";

function postBrowserAnnotationProbe(): void {
  window.postMessage(
    {
      source: BROWSER_ANNOTATION_PAGE_SOURCE,
      type: BROWSER_ANNOTATION_PROBE_MESSAGE,
    },
    window.location.origin,
  );
}

function postBrowserTransferStart(request: BrowserTransferSetupRequest): void {
  window.postMessage(
    {
      source: BROWSER_ANNOTATION_PAGE_SOURCE,
      type: BROWSER_TRANSFER_START_MESSAGE,
      id: request.id,
      devServerUrl: request.devServerUrl,
      ...(request.groupTitle ? { groupTitle: request.groupTitle } : {}),
    },
    window.location.origin,
  );
}

async function copyToClipboard(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard access is unavailable in this browser.");
  }
  await navigator.clipboard.writeText(text);
}

export function BrowserTransferSetupPrompt() {
  const [request, setRequest] = useState<BrowserTransferSetupRequest | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    return readRememberedBrowserTransferSetupRequest();
  });
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onSetupRequest = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isBrowserTransferSetupRequest(event.detail)) {
        return;
      }

      rememberBrowserTransferSetupRequest(event.detail);
      setRequest(event.detail);
      setVisible(true);
    };

    window.addEventListener(BROWSER_TRANSFER_SETUP_REQUEST_EVENT, onSetupRequest);
    return () => {
      window.removeEventListener(BROWSER_TRANSFER_SETUP_REQUEST_EVENT, onSetupRequest);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const currentRequest =
      rememberBrowserTransferSetupRequestFromUrl(new URL(window.location.href)) ??
      readRememberedBrowserTransferSetupRequest();
    setRequest(currentRequest);
    setVisible(false);

    if (!currentRequest) {
      return;
    }

    let extensionResponded = false;
    const markExtensionReady = () => {
      extensionResponded = true;
      postBrowserTransferStart(currentRequest);
      clearRememberedBrowserTransferSetupRequest();
      setRequest(null);
      setVisible(false);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) {
        return;
      }
      if (!isBrowserAnnotationExtensionMessage(event.data)) {
        return;
      }
      if (
        event.data.type !== BROWSER_ANNOTATION_READY_MESSAGE &&
        event.data.type !== BROWSER_ANNOTATION_STATUS_MESSAGE
      ) {
        return;
      }
      markExtensionReady();
    };

    window.addEventListener("message", onMessage);
    postBrowserAnnotationProbe();
    const retryTimer = window.setTimeout(postBrowserAnnotationProbe, 350);
    const showTimer = window.setTimeout(() => {
      if (!extensionResponded) {
        setVisible(true);
      }
    }, BROWSER_TRANSFER_EXTENSION_RESPONSE_TIMEOUT_MS);

    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(retryTimer);
      window.clearTimeout(showTimer);
    };
  }, []);

  const copyPath = useCallback(() => {
    if (!request) {
      return;
    }

    void copyToClipboard(request.extensionInstallPath)
      .then(() => {
        toastManager.add({
          type: "success",
          title: "Extension path copied",
        });
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not copy extension path",
            description: error instanceof Error ? error.message : "Clipboard access failed.",
          }),
        );
      });
  }, [request]);

  const copyExtensionsUrl = useCallback(() => {
    void copyToClipboard(CHROME_EXTENSIONS_URL)
      .then(() => {
        toastManager.add({
          type: "success",
          title: "Chrome extensions URL copied",
        });
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not copy Chrome URL",
            description: error instanceof Error ? error.message : "Clipboard access failed.",
          }),
        );
      });
  }, []);

  const retry = useCallback(() => {
    window.location.reload();
  }, []);

  const dismiss = useCallback(() => {
    clearRememberedBrowserTransferSetupRequest();
    setRequest(null);
    setVisible(false);
  }, []);

  if (!request || !visible) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 px-4 py-6 backdrop-blur-sm">
      <section className="w-full max-w-lg rounded-lg border border-border bg-card p-5 text-card-foreground shadow-xl">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary">
            <PuzzleIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold tracking-normal">Install T3 Code extension</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Chrome did not respond to the transfer request. Load the local extension once, then
              retry the transfer tab.
            </p>
          </div>
          <Button
            aria-label="Dismiss extension setup"
            className="-mr-1 -mt-1"
            size="icon-sm"
            variant="ghost"
            onClick={dismiss}
          >
            <XIcon className="size-4" />
          </Button>
        </div>

        <div className="mt-4 rounded-md border border-border/80 bg-background/70 p-3">
          <ol className="space-y-2 text-sm text-foreground">
            <li>1. Open chrome://extensions.</li>
            <li>2. Enable Developer mode.</li>
            <li>3. Choose Load unpacked and select this folder:</li>
          </ol>
          <code className="mt-2 block max-h-24 overflow-auto rounded-md border border-border bg-muted/70 px-2 py-1.5 text-xs text-muted-foreground">
            {request.extensionInstallPath}
          </code>
          {request.extensionInstallPath !== SOURCE_BROWSER_TRANSFER_EXTENSION_PATH ? (
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Running from source: use{" "}
              <code className="rounded border border-border bg-muted/70 px-1 py-0.5">
                {SOURCE_BROWSER_TRANSFER_EXTENSION_PATH}
              </code>
              .
            </p>
          ) : null}
        </div>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          <Button variant="outline" size="sm" onClick={copyExtensionsUrl}>
            <ExternalLinkIcon className="size-4" />
            Copy chrome://extensions
          </Button>
          <Button variant="outline" size="sm" onClick={copyPath}>
            <CopyIcon className="size-4" />
            Copy path
          </Button>
          <Button variant="default" size="sm" onClick={retry}>
            <RefreshCwIcon className="size-4" />
            Retry
          </Button>
        </div>
      </section>
    </div>
  );
}
