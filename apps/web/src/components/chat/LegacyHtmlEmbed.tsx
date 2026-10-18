import { clampHtmlRenderHeight } from "@t3tools/shared/htmlRender";
import { useState } from "react";

import { LRUCache } from "~/lib/lruCache";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";

const DEFAULT_HEIGHT = 220;

// Nothing measured these pages ahead of time, so a remount (a virtualized row
// scrolling back in) starts from the height the page last reported rather than
// the default, and the thread does not jump while it loads again.
const reportedHeights = new LRUCache<number>(64, 1 << 20);

/**
 * A legacy `t3-html` fence shown as an inline HTML render: borderless on the
 * thread background, sized to the height the page reports.
 */
export function LegacyHtmlEmbedFrame(props: { readonly html: string }) {
  const { html } = props;
  const [contentHeight, setContentHeight] = useState(() => reportedHeights.get(html));
  const handleContentHeight = (height: number) => {
    reportedHeights.set(html, height, html.length * 2 + 16);
    setContentHeight(height);
  };
  return (
    <div style={{ height: clampHtmlRenderHeight(contentHeight ?? DEFAULT_HEIGHT) }}>
      <HtmlRenderDocument
        key={html}
        html={html}
        title="Interactive embed"
        className="block size-full"
        onContentHeight={handleContentHeight}
      />
    </div>
  );
}

/** The same page at dialog size, for embeds that need more room than the reply column. */
export function LegacyHtmlEmbedDialog(props: {
  readonly html: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="h-[85vh] max-w-5xl">
        <DialogHeader>
          <DialogTitle>Interactive embed</DialogTitle>
        </DialogHeader>
        {props.open ? (
          <HtmlRenderDocument
            html={props.html}
            title="Interactive embed"
            className="min-h-0 flex-1 rounded-b-2xl"
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
