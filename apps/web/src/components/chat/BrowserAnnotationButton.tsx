import { memo, useCallback, useEffect, useState } from "react";
import { MousePointer2Icon } from "lucide-react";

import {
  BROWSER_ANNOTATION_ACTIVATE_MESSAGE,
  BROWSER_ANNOTATION_PAGE_SOURCE,
  BROWSER_ANNOTATION_PROBE_MESSAGE,
  BROWSER_ANNOTATION_READY_MESSAGE,
  BROWSER_ANNOTATION_STATUS_MESSAGE,
  isBrowserAnnotationExtensionMessage,
} from "../../browserAnnotation";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";

function postBrowserAnnotationMessage(type: string): void {
  const message = {
    source: BROWSER_ANNOTATION_PAGE_SOURCE,
    type,
  };
  window.postMessage(message, window.location.origin);
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(message, "*");
  }
}

function isBrowserAnnotationMessageEvent(event: MessageEvent): boolean {
  if (event.source === window && event.origin === window.location.origin) {
    return true;
  }
  return (
    window.parent !== window &&
    event.source === window.parent &&
    event.origin.startsWith("chrome-extension://")
  );
}

export const BrowserAnnotationButton = memo(function BrowserAnnotationButton() {
  const [extensionReady, setExtensionReady] = useState(false);
  const [linked, setLinked] = useState(false);
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState(false);
  const [ambiguous, setAmbiguous] = useState(false);
  const [targetUrl, setTargetUrl] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const probe = () => {
      postBrowserAnnotationMessage(BROWSER_ANNOTATION_PROBE_MESSAGE);
    };
    const onMessage = (event: MessageEvent) => {
      if (!isBrowserAnnotationMessageEvent(event)) {
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

      setExtensionReady(true);
      setLinked(event.data.linked);
      setActive(event.data.active);
      setAmbiguous(Boolean(event.data.browserContext?.ambiguous));
      setTargetUrl(event.data.browserContext?.annotationTarget?.url ?? null);
      setPending(false);
      if (event.data.type === BROWSER_ANNOTATION_STATUS_MESSAGE && event.data.error) {
        toastManager.add({
          type: "error",
          title: "Could not start annotation",
          description: event.data.error,
        });
      }
    };

    window.addEventListener("message", onMessage);
    probe();
    const firstRetry = window.setTimeout(probe, 250);
    const secondRetry = window.setTimeout(probe, 1_000);
    const interval = window.setInterval(probe, 5_000);

    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(firstRetry);
      window.clearTimeout(secondRetry);
      window.clearInterval(interval);
    };
  }, []);

  const onClick = useCallback(() => {
    if (!extensionReady) {
      toastManager.add({
        type: "warning",
        title: "Chrome extension is not responding",
        description: "Install or reload the T3 Code Chrome extension, then refresh this tab.",
      });
      return;
    }

    if (ambiguous) {
      toastManager.add({
        type: "warning",
        title: "Multiple preview tabs found",
        description: "Use Transfer to Browser again so T3 Code can identify one preview tab.",
      });
      return;
    }

    if (!linked) {
      toastManager.add({
        type: "info",
        title: "No linked preview tab",
        description: "Use Transfer to Browser from the desktop app to link the preview tab.",
      });
      return;
    }

    setPending(true);
    postBrowserAnnotationMessage(BROWSER_ANNOTATION_ACTIVATE_MESSAGE);
  }, [ambiguous, extensionReady, linked]);

  const tooltipText = !extensionReady
    ? "Install or reload the T3 Code Chrome extension."
    : ambiguous
      ? "Multiple preview tabs found."
      : !linked
        ? "Use Transfer to Browser from the desktop app to link a preview tab."
        : active
          ? "Click an element in the preview tab."
          : targetUrl
            ? `Annotate ${targetUrl}`
            : "Annotate the linked browser preview.";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="xs"
            className={cn(
              "shrink-0",
              active && "border-primary/50 bg-primary/10 text-primary",
              (ambiguous || (extensionReady && !linked)) &&
                "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
              !extensionReady && "text-muted-foreground",
            )}
            aria-label="Annotate browser preview"
            disabled={pending}
            onClick={onClick}
          >
            <MousePointer2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="bottom">{tooltipText}</TooltipPopup>
    </Tooltip>
  );
});
