import { CheckIcon, CopyIcon, Maximize2Icon, XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LRUCache } from "../../lib/lruCache";

export const HTML_EMBED_FENCE_LANGUAGE = "t3-html";

export function isHtmlEmbedLanguage(language: string | null | undefined): boolean {
  return language?.trim().toLowerCase() === HTML_EMBED_FENCE_LANGUAGE;
}

const EMBED_HEIGHT_MESSAGE_TYPE = "t3-html-embed:height";
const INLINE_MIN_HEIGHT = 96;
const INLINE_MAX_HEIGHT = 480;
const INLINE_DEFAULT_HEIGHT = 220;
/** Streaming appends re-render markdown per token; only reload the iframe once the fence content is stable. */
const SETTLE_DELAY_MS = 400;

const FULL_DOCUMENT_PATTERN = /^\s*(?:<!doctype\b|<html\b)/i;

// sandbox="allow-scripts" isolates the frame from the app but does not stop
// fetch/XHR/external subresources; the CSP closes off network access, form
// submission, and <base> retargeting so embeds cannot exfiltrate anything or
// load remote content.
const EMBED_CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'">`;

// documentElement.scrollHeight is clamped to the iframe viewport, so it can
// never report a shrink; the body is not the scrolling box and tracks true
// content height in both directions.
const HEIGHT_REPORTER_SCRIPT = `<script>(function(){var report=function(){var body=document.body;var height=body?Math.max(body.scrollHeight,body.offsetHeight):document.documentElement.scrollHeight;parent.postMessage({type:"${EMBED_HEIGHT_MESSAGE_TYPE}",height:height},"*");};var schedule=function(){if(window.requestAnimationFrame){requestAnimationFrame(report);}else{report();}};window.addEventListener("load",schedule);if(window.ResizeObserver){new ResizeObserver(schedule).observe(document.documentElement);}var ticks=0;var timer=setInterval(function(){report();ticks+=1;if(ticks>=10){clearInterval(timer);}},500);schedule();})();</script>`;

export function buildHtmlEmbedDocument(code: string, theme: "light" | "dark"): string {
  // The CSP head must precede every untrusted byte, and inserting into
  // agent markup with string matching is spoofable (decoy <head> text in
  // comments or scripts). So the trusted head is always emitted first and the
  // agent's document follows verbatim: the HTML parser ignores its extra
  // doctype, merges its <html> attributes, and reparents its head content
  // into the body, where <style>/<script>/<meta> still function. Trailing
  // scripts are likewise reparented, so height reporting still works.
  if (FULL_DOCUMENT_PATTERN.test(code)) {
    return `<!doctype html><html><head>${EMBED_CSP_META}<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>${code}\n${HEIGHT_REPORTER_SCRIPT}</html>`;
  }
  return `<!doctype html><html><head>${EMBED_CSP_META}<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{color-scheme:${theme}}html,body{margin:0;background:transparent}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.45;color:CanvasText;padding:12px;box-sizing:border-box;overflow-wrap:break-word}</style></head><body>${code}\n${HEIGHT_REPORTER_SCRIPT}</body></html>`;
}

function useSettledValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (settled === value) return;
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, settled, value]);
  return settled;
}

function clampInlineHeight(height: number): number {
  return Math.min(INLINE_MAX_HEIGHT, Math.max(INLINE_MIN_HEIGHT, Math.ceil(height)));
}

// A remount (virtualized row scrolling back in, error-boundary reset) rebuilds
// the iframe from scratch; seeding the last measured height keeps the block
// from collapsing to the default and re-expanding once the reporter runs.
const inlineHeightCache = new LRUCache<number>(64, 1 << 20);

function EmbedFrame({
  srcDoc,
  className,
  style,
  onHeight,
}: {
  srcDoc: string;
  className: string;
  style?: React.CSSProperties;
  onHeight?: ((height: number) => void) | undefined;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!onHeight) return;
    const onMessage = (event: MessageEvent) => {
      if (iframeRef.current == null || event.source !== iframeRef.current.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown } | null;
      if (data?.type !== EMBED_HEIGHT_MESSAGE_TYPE || typeof data.height !== "number") return;
      if (!Number.isFinite(data.height) || data.height <= 0) return;
      onHeight(data.height);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onHeight]);

  return (
    <iframe
      ref={iframeRef}
      title="Interactive embed"
      // No allow-same-origin: the frame gets an opaque origin and cannot touch
      // the app, its storage, or cookies; scripts inside the snippet still run.
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className={className}
      style={style}
      loading="lazy"
    />
  );
}

function ExpandedEmbedDialog({ srcDoc, onClose }: { srcDoc: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || dialogRef.current == null) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, iframe, a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      const inDialog = active instanceof HTMLElement && dialogRef.current.contains(active);
      if (event.shiftKey && (active === first || !inDialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inDialog)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-2 py-4 sm:px-6 sm:py-8 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded interactive embed"
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Dismiss embed"
        onClick={onClose}
      />
      <div className="relative z-10 flex h-full max-h-[92vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <span className="text-xs font-medium text-muted-foreground select-none">
            Interactive embed
          </span>
          <Button
            ref={closeButtonRef}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Close expanded embed"
            onClick={onClose}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
        <EmbedFrame srcDoc={srcDoc} className="block w-full flex-1 border-0 bg-transparent" />
      </div>
    </div>,
    document.body,
  );
}

export const HtmlEmbedBlock = memo(function HtmlEmbedBlock({
  code,
  theme,
}: {
  code: string;
  theme: "light" | "dark";
}) {
  const settledCode = useSettledValue(code, SETTLE_DELAY_MS);
  const srcDoc = useMemo(() => buildHtmlEmbedDocument(settledCode, theme), [settledCode, theme]);
  const [inlineHeight, setInlineHeight] = useState(
    () => inlineHeightCache.get(code) ?? INLINE_DEFAULT_HEIGHT,
  );
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleHeight = useCallback(
    (height: number) => {
      const clamped = clampInlineHeight(height);
      inlineHeightCache.set(code, clamped, code.length * 2 + 16);
      setInlineHeight(clamped);
    },
    [code],
  );

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) return;
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) clearTimeout(copiedTimerRef.current);
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        console.error("[chat-markdown] action failed", { operation: "copy-html-embed" }, cause);
      });
  }, [code]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  const copyLabel = copied ? "Copied" : "Copy source";

  return (
    <div className="chat-markdown-codeblock my-2 overflow-hidden" data-language="t3-html">
      <div className="chat-markdown-codeblock-header select-none">
        <span className="chat-markdown-codeblock-title">
          <span className="truncate">Interactive embed</span>
        </span>
        <span className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  onClick={handleCopy}
                  aria-label={copyLabel}
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  onClick={() => setExpanded(true)}
                  aria-label="Expand embed"
                />
              }
            >
              <Maximize2Icon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">Expand embed</TooltipPopup>
          </Tooltip>
        </span>
      </div>
      <EmbedFrame
        srcDoc={srcDoc}
        onHeight={handleHeight}
        className="block w-full border-0 bg-transparent"
        style={{ height: inlineHeight }}
      />
      {expanded ? <ExpandedEmbedDialog srcDoc={srcDoc} onClose={() => setExpanded(false)} /> : null}
    </div>
  );
});
