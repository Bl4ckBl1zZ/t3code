import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  clampHtmlRenderHeight,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderInlineDocument,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  type HtmlRenderReference,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Platform, Pressable, View, type ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { mobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

const ROW_BOTTOM_MARGIN = 8;
const FULL_SCREEN_GUTTER = 16;

/** A render row is its frame's height plus spacing; the page's content never sizes it. */
export function htmlRenderRowHeight(frameHeight: number) {
  return frameHeight + ROW_BOTTOM_MARGIN;
}

function useHtmlRenderTheme() {
  const { themeId, themeAppearance, themeVariables, systemColorsActive } =
    useAppearancePreferences();
  return useMemo(
    () =>
      mobileHtmlRenderTheme({
        themeId,
        appearance: themeAppearance,
        variables: themeVariables,
        systemColors: systemColorsActive,
        platform: Platform.OS,
      }),
    [themeId, themeAppearance, themeVariables, systemColorsActive],
  );
}

function postTheme(view: WebView<object> | null, theme: HtmlRenderTheme) {
  view?.injectJavaScript(
    `window.postMessage(${JSON.stringify(htmlRenderThemeMessage(theme))}, "*"); true;`,
  );
}

const OVERFLOW_MESSAGE_TYPE = "t3-html-render-overflow";

// Reports which ways the page overflows its frame, so a feed row only takes
// scroll gestures from a page that can use them.
const OVERFLOW_SCRIPT = `(function(){var last;function report(){var d=document.documentElement,b=document.body;var x=Math.max(d.scrollWidth,b?b.scrollWidth:0)>window.innerWidth+1,y=Math.max(d.scrollHeight,b?b.scrollHeight:0)>window.innerHeight+1,o=x+","+y;if(o===last)return;last=o;window.ReactNativeWebView.postMessage(JSON.stringify({type:${JSON.stringify(OVERFLOW_MESSAGE_TYPE)},x:x,y:y}));}report();if(window.ResizeObserver){var r=new ResizeObserver(report);r.observe(document.documentElement);if(document.body)r.observe(document.body);}window.addEventListener("resize",report);})();true;`;

type Overflow = { readonly x: boolean; readonly y: boolean };

const NO_OVERFLOW: Overflow = { x: false, y: false };

function readOverflowMessage(data: string): Overflow | null {
  try {
    const message: unknown = JSON.parse(data);
    return typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === OVERFLOW_MESSAGE_TYPE &&
      "x" in message &&
      typeof message.x === "boolean" &&
      "y" in message &&
      typeof message.y === "boolean"
      ? { x: message.x, y: message.y }
      : null;
  } catch {
    return null;
  }
}

const HEIGHT_MESSAGE_TYPE = "t3-html-render-height";

// Reports the page's content height, measured as a framed page's bootstrap
// measures it, for pages no server measured (legacy inline embeds).
const HEIGHT_SCRIPT = `(function(){var last;function report(){var d=document.documentElement,h=Math.ceil(d.scrollHeight>d.clientHeight?d.scrollHeight:d.getBoundingClientRect().height);if(h===last)return;last=h;window.ReactNativeWebView.postMessage(JSON.stringify({type:${JSON.stringify(HEIGHT_MESSAGE_TYPE)},height:h}));}report();if(window.ResizeObserver){var r=new ResizeObserver(report);r.observe(document.documentElement);if(document.body)r.observe(document.body);}window.addEventListener("load",report);})();true;`;

function readHeightMessage(data: string): number | null {
  try {
    const message: unknown = JSON.parse(data);
    return typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === HEIGHT_MESSAGE_TYPE &&
      "height" in message &&
      typeof message.height === "number" &&
      Number.isFinite(message.height) &&
      message.height > 0
      ? message.height
      : null;
  } catch {
    return null;
  }
}

const withoutFragment = (url: string) => url.split("#", 1)[0];

// A page given as a string (`html`) loads as this document.
const INLINE_DOCUMENT_URL = "about:blank";

/**
 * An agent's HTML page, themed before first paint and kept in step with the app theme.
 * The page may move within its own document; links leave for the browser. A page
 * held as a string (`html`, a legacy embed) loads with the theme written in.
 */
export function HtmlRenderWebView(
  props: ({ readonly uri: string } | { readonly html: string }) & {
    readonly title: string;
    /** Inside the feed, the page takes scroll gestures only when it overflows its frame. */
    readonly nested: boolean;
    readonly onLoadError?: () => void;
    /** Receives the page's content height whenever it changes, for pages without a measured height. */
    readonly onContentHeight?: (height: number) => void;
  },
) {
  const theme = useHtmlRenderTheme();
  const [initialTheme] = useState(theme);
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [overflow, setOverflow] = useState(NO_OVERFLOW);
  const webView = useRef<WebView<object>>(null);
  const crashes = useRef(0);
  // The theme the loaded document shows; null until it loads.
  const shownTheme = useRef<HtmlRenderTheme | null>(null);
  const uri = "uri" in props ? props.uri : null;
  const html = "html" in props ? props.html : null;
  const pageUrl = uri ?? INLINE_DOCUMENT_URL;
  const source = useMemo(
    () =>
      html !== null
        ? { html: htmlRenderInlineDocument(html, initialTheme) }
        : { uri: pageUrl + htmlRenderThemeFragment(initialTheme) },
    [html, pageUrl, initialTheme],
  );
  const { onContentHeight } = props;
  const injectedJavaScript = [
    props.nested ? OVERFLOW_SCRIPT : "",
    onContentHeight ? HEIGHT_SCRIPT : "",
  ].join("");
  useEffect(() => {
    if (shownTheme.current === null || shownTheme.current === theme) return;
    shownTheme.current = theme;
    postTheme(webView.current, theme);
  }, [theme]);
  const restart = () => {
    // A page that keeps crashing its web process is not reloaded forever.
    crashes.current += 1;
    if (crashes.current > 1) {
      props.onLoadError?.();
      return;
    }
    shownTheme.current = null;
    setLoaded(false);
    setOverflow(NO_OVERFLOW);
    setGeneration((value) => value + 1);
  };
  const scrollable = !props.nested || overflow.x || overflow.y;
  // Pages have no horizontal padding of their own, so full screen adds the
  // feed's gutter in the page's background color.
  return (
    <View
      style={
        props.nested
          ? { flex: 1 }
          : {
              flex: 1,
              paddingHorizontal: FULL_SCREEN_GUTTER,
              backgroundColor: theme.variables["--background"],
            }
      }
    >
      <WebView<object>
        key={generation}
        ref={webView}
        source={source}
        accessibilityLabel={props.title}
        style={{ flex: 1, backgroundColor: "transparent" }}
        allowsInlineMediaPlayback
        automaticallyAdjustContentInsets={!props.nested}
        bounces={!props.nested}
        showsVerticalScrollIndicator={!props.nested}
        showsHorizontalScrollIndicator={!props.nested}
        scrollEnabled={scrollable}
        // Android only: the page holds vertical drags until it reaches an edge,
        // then hands them to the feed (patches/react-native-webview). A page
        // that only overflows sideways leaves vertical drags to the feed.
        nestedScrollEnabled={props.nested && overflow.y}
        overScrollMode={props.nested ? "never" : "always"}
        // Only the page itself loads here; other top-frame navigations are
        // dropped. A link the reader taps opens as a new window, which the
        // platform allows only from a tap, and goes to the browser.
        onShouldStartLoadWithRequest={(request) =>
          request.isTopFrame === false || withoutFragment(request.url) === withoutFragment(pageUrl)
        }
        onOpenWindow={(event) => {
          const url = event.nativeEvent.targetUrl;
          if (/^https?:/i.test(url)) void tryOpenExternalUrl(url, "html-render");
        }}
        onLoadEnd={() => {
          setLoaded(true);
          shownTheme.current = theme;
          if (theme !== initialTheme) postTheme(webView.current, theme);
        }}
        onError={props.onLoadError}
        onHttpError={props.onLoadError}
        onContentProcessDidTerminate={restart}
        onRenderProcessGone={restart}
        {...(injectedJavaScript !== ""
          ? {
              injectedJavaScript,
              onMessage: (event: WebViewMessageEvent) => {
                const next = readOverflowMessage(event.nativeEvent.data);
                if (next !== null) setOverflow(next);
                const height = readHeightMessage(event.nativeEvent.data);
                if (height !== null) onContentHeight?.(height);
              },
            }
          : {})}
      />
      {loaded ? null : (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <ActivityIndicator />
        </View>
      )}
    </View>
  );
}

/** A completed `html_render` call in the thread feed: the page itself, at a fixed height. */
export function ThreadHtmlRender(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly render: HtmlRenderReference;
  /** The feed's content width; the frame's height follows the page's measured height there. */
  readonly frameWidth: number;
  readonly iconColor: ColorValue;
}) {
  const navigation = useNavigation();
  const { attachmentId, title } = props.render;
  const height = htmlRenderFrameHeight(props.render, props.frameWidth);
  const fileName = htmlRenderFileName(title);
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      fileName,
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId, fileName],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  const refresh = useRefreshAssetUrl(props.environmentId, resource);
  // Signed URLs are re-minted periodically; following them would reload the page.
  const [uri, setUri] = useState<string | null>(null);
  if (uri === null && asset._tag === "Success") setUri(asset.url);
  const [failed, setFailed] = useState(false);
  // A failed load retries once with a fresh URL, or remounts on the same one,
  // since the failure may have been the connection rather than the URL.
  const [attempt, setAttempt] = useState(0);
  const retried = useRef(false);
  const handleLoadError = () => {
    if (retried.current) {
      setFailed(true);
      return;
    }
    retried.current = true;
    void refresh().then((next) => {
      if (next === null) setFailed(true);
      else if (next !== uri) setUri(next);
      else setAttempt((value) => value + 1);
    });
  };

  return (
    <View style={{ marginBottom: ROW_BOTTOM_MARGIN }}>
      <View style={{ height }}>
        {uri !== null && !failed ? (
          <HtmlRenderWebView
            key={`${uri}:${attempt}`}
            uri={uri}
            title={title}
            nested
            onLoadError={handleLoadError}
          />
        ) : failed || asset._tag === "Failure" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Reload ${title}`}
            className="flex-1 items-center justify-center"
            onPress={() => {
              retried.current = false;
              setFailed(false);
              if (uri === null) void refresh().then((next) => next !== null && setUri(next));
            }}
          >
            <Text className="text-sm text-foreground-muted">Page unavailable</Text>
          </Pressable>
        ) : (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator />
          </View>
        )}
        {uri !== null && !failed ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${title}`}
            hitSlop={8}
            className="absolute right-1.5 top-1.5 h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-card/80"
            onPress={() =>
              navigation.navigate("ThreadAttachment", {
                environmentId: String(props.environmentId),
                threadId: String(props.threadId),
                attachmentId,
                name: fileName,
                mimeType: "text/html",
                sizeBytes: "0",
                htmlRender: "1",
              })
            }
          >
            <SymbolView
              name="arrow.up.left.and.arrow.down.right"
              size={12}
              tintColor={props.iconColor}
              type="monochrome"
            />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const LEGACY_EMBED_DEFAULT_HEIGHT = 220;

/**
 * A legacy `t3-html` fence inside an assistant reply: the page inline at the
 * height it reports, with a full-screen view for pages that need more room.
 */
export function ThreadLegacyHtmlEmbed(props: { readonly html: string }) {
  const insets = useSafeAreaInsets();
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const height = clampHtmlRenderHeight(contentHeight ?? LEGACY_EMBED_DEFAULT_HEIGHT);
  return (
    <View style={{ marginBottom: ROW_BOTTOM_MARGIN, height }}>
      {failed ? (
        <View className="flex-1 items-center justify-center">
          <Text className="text-sm text-foreground-muted">Embed unavailable</Text>
        </View>
      ) : (
        <>
          <HtmlRenderWebView
            html={props.html}
            title="Interactive embed"
            nested
            onLoadError={() => setFailed(true)}
            onContentHeight={setContentHeight}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Expand embed"
            hitSlop={8}
            className="absolute right-1.5 top-1.5 h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-card/80"
            onPress={() => setExpanded(true)}
          >
            <SymbolView
              name="arrow.up.left.and.arrow.down.right"
              size={12}
              tintColorClassName="accent-icon-subtle"
              type="monochrome"
            />
          </Pressable>
        </>
      )}
      <Modal
        visible={expanded}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setExpanded(false)}
      >
        <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
          <View className="h-11 flex-row items-center justify-between px-3">
            <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
              Interactive embed
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close embed"
              hitSlop={8}
              onPress={() => setExpanded(false)}
            >
              <SymbolView
                name="xmark"
                size={18}
                tintColorClassName="accent-icon-subtle"
                type="monochrome"
              />
            </Pressable>
          </View>
          <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
            {expanded ? (
              <HtmlRenderWebView html={props.html} title="Interactive embed" nested={false} />
            ) : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}
