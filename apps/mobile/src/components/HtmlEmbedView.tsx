import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pressable, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AppText as Text } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { useThemeColor } from "../lib/useThemeColor";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

export const HTML_EMBED_FENCE_LANGUAGE = "t3-html";

export function isHtmlEmbedLanguage(language: string | null | undefined): boolean {
  return language?.trim().toLowerCase() === HTML_EMBED_FENCE_LANGUAGE;
}

const EMBED_HEIGHT_MESSAGE_TYPE = "t3-html-embed:height";
const INLINE_MIN_HEIGHT = 96;
// Not a display cap: the inline WebView grows to the full reported content
// height so nothing is ever clipped. This bound only keeps a runaway feedback
// loop bounded — an embed sized in vh/% plus padding reports a taller body on
// every resize, which would otherwise grow without limit.
const INLINE_RUNAWAY_HEIGHT_LIMIT = 20000;
const INLINE_DEFAULT_HEIGHT = 220;
/** Streaming appends re-render markdown per token; only reload the WebView once the fence content is stable. */
const SETTLE_DELAY_MS = 400;

const FULL_DOCUMENT_PATTERN = /^\s*(?:<!doctype\b|<html\b)/i;

// Navigation guards do not stop fetch/XHR/external subresources; the CSP
// closes off network access, form submission, and <base> retargeting so
// embeds cannot exfiltrate anything or load remote content.
const EMBED_CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'">`;

// documentElement.scrollHeight is clamped to the WebView viewport, so it can
// never report a shrink; the body is not the scrolling box and tracks true
// content height in both directions.
const HEIGHT_REPORTER_SCRIPT = `<script>(function(){var report=function(){var body=document.body;var height=body?Math.max(body.scrollHeight,body.offsetHeight):document.documentElement.scrollHeight;if(window.ReactNativeWebView){window.ReactNativeWebView.postMessage(JSON.stringify({type:"${EMBED_HEIGHT_MESSAGE_TYPE}",height:height}));}};var schedule=function(){if(window.requestAnimationFrame){requestAnimationFrame(report);}else{report();}};window.addEventListener("load",schedule);if(window.ResizeObserver){new ResizeObserver(schedule).observe(document.documentElement);}var ticks=0;var timer=setInterval(function(){report();ticks+=1;if(ticks>=10){clearInterval(timer);}},500);schedule();})();</script>`;

function buildHtmlEmbedDocument(code: string, theme: "light" | "dark"): string {
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

/** Snippets stay inside their document: block navigations away from the inline html. */
function allowEmbedNavigation(url: string): boolean {
  return url === "about:blank" || url.startsWith("about:blank#") || url.startsWith("data:");
}

function EmbedWebView(props: {
  readonly html: string;
  readonly scrollEnabled: boolean;
  readonly style: { readonly height?: number; readonly flex?: number };
  readonly onHeight?: (height: number) => void;
}) {
  const onHeight = props.onHeight;
  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (!onHeight) return;
      try {
        const data = JSON.parse(event.nativeEvent.data) as {
          type?: unknown;
          height?: unknown;
        } | null;
        if (data?.type !== EMBED_HEIGHT_MESSAGE_TYPE || typeof data.height !== "number") return;
        if (!Number.isFinite(data.height) || data.height <= 0) return;
        onHeight(data.height);
      } catch {
        // Ignore malformed messages from embedded scripts.
      }
    },
    [onHeight],
  );

  return (
    <WebView
      source={{ html: props.html }}
      originWhitelist={["about:*", "data:*"]}
      javaScriptEnabled
      setSupportMultipleWindows={false}
      allowsLinkPreview={false}
      allowFileAccess={false}
      scrollEnabled={props.scrollEnabled}
      onMessage={handleMessage}
      onShouldStartLoadWithRequest={(request) => allowEmbedNavigation(request.url)}
      style={{ backgroundColor: "transparent", ...props.style }}
    />
  );
}

export function HtmlEmbedView(props: { readonly html: string }) {
  const { themeAppearance: theme } = useAppearancePreferences();
  const settledHtml = useSettledValue(props.html, SETTLE_DELAY_MS);
  const document = useMemo(() => buildHtmlEmbedDocument(settledHtml, theme), [settledHtml, theme]);
  const [inlineHeight, setInlineHeight] = useState(INLINE_DEFAULT_HEIGHT);
  const [expanded, setExpanded] = useState(false);
  const iconColor = String(useThemeColor("--color-icon-subtle"));

  const handleHeight = useCallback((height: number) => {
    setInlineHeight(
      Math.min(INLINE_RUNAWAY_HEIGHT_LIMIT, Math.max(INLINE_MIN_HEIGHT, Math.ceil(height))),
    );
  }, []);

  return (
    <View className="my-2 min-w-0 max-w-full self-stretch overflow-hidden rounded-lg border border-border bg-card">
      <View className="flex-row items-center justify-between border-b border-border py-1 pr-1 pl-3">
        <Text className="flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          Interactive embed
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Expand embed"
          hitSlop={8}
          className="size-8 items-center justify-center rounded-md active:opacity-60"
          onPress={() => setExpanded(true)}
        >
          <SymbolView name="arrow.up.left.and.arrow.down.right" size={15} tintColor={iconColor} />
        </Pressable>
      </View>
      <EmbedWebView
        html={document}
        scrollEnabled={false}
        style={{ height: inlineHeight }}
        onHeight={handleHeight}
      />
      <Modal
        visible={expanded}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setExpanded(false)}
      >
        <View className="flex-1 bg-card">
          <View className="flex-row items-center justify-between border-b border-border px-4 py-3">
            <Text className="text-sm font-t3-bold text-foreground">Interactive embed</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close embed"
              hitSlop={8}
              className="size-8 items-center justify-center rounded-full active:opacity-60"
              onPress={() => setExpanded(false)}
            >
              <SymbolView name="xmark" size={16} tintColor={iconColor} />
            </Pressable>
          </View>
          {expanded ? <EmbedWebView html={document} scrollEnabled style={{ flex: 1 }} /> : null}
        </View>
      </Modal>
    </View>
  );
}
