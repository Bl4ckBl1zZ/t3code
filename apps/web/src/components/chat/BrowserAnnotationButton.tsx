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
  window.postMessage(
    {
      source: BROWSER_ANNOTATION_PAGE_SOURCE,
      type,
    },
    window.location.origin,
  );
}

export const BrowserAnnotationButton = memo(function BrowserAnnotationButton() {
  const [linked, setLinked] = useState(false);
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const probe = () => {
      postBrowserAnnotationMessage(BROWSER_ANNOTATION_PROBE_MESSAGE);
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

      setLinked(event.data.linked);
      setActive(event.data.active);
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
    setPending(true);
    postBrowserAnnotationMessage(BROWSER_ANNOTATION_ACTIVATE_MESSAGE);
  }, []);

  if (!linked) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="xs"
            className={cn("shrink-0", active && "border-primary/50 bg-primary/10 text-primary")}
            aria-label="Annotate browser preview"
            disabled={pending}
            onClick={onClick}
          >
            <MousePointer2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="bottom">
        {active ? `Click an element in the preview tab.` : `Annotate the linked browser preview.`}
      </TooltipPopup>
    </Tooltip>
  );
});
