import {
  OrganizationPanelDynamicRpcMethod,
  type OrganizationPanelSnapshot,
} from "@t3tools/contracts";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { getPrimaryEnvironmentConnection } from "../environments/runtime";

interface OrganizationPanelHostProps {
  readonly snapshot: OrganizationPanelSnapshot;
}

const ORGANIZATION_PANEL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src https: data: blob:",
  "font-src data:",
  "connect-src https:",
  "media-src https: data: blob:",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const ORGANIZATION_PANEL_MIN_HEIGHT = 448;
const ORGANIZATION_PANEL_MAX_HEIGHT = 120_000;

const ORGANIZATION_PANEL_DESIGN_STYLE = `<style id="t3-organization-panel-design">
  :root {
    color-scheme: dark;
    --t3-background: #111111;
    --t3-foreground: #f5f5f5;
    --t3-card: #151515;
    --t3-card-foreground: #f5f5f5;
    --t3-muted: rgba(255, 255, 255, 0.04);
    --t3-muted-foreground: rgba(245, 245, 245, 0.64);
    --t3-border: rgba(255, 255, 255, 0.08);
    --t3-input: rgba(255, 255, 255, 0.1);
    --t3-primary: oklch(0.588 0.217 264);
    --t3-primary-foreground: #ffffff;
    --t3-radius: 8px;
    font-family:
      "DM Sans",
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      system-ui,
      sans-serif;
    background: var(--t3-background);
    color: var(--t3-foreground);
  }

  *, *::before, *::after {
    box-sizing: border-box;
  }

  html {
    min-width: 0;
    overflow-x: hidden;
    background: var(--t3-background) !important;
  }

  body {
    min-width: 0;
    min-height: 100vh;
    margin: 0 !important;
    overflow-x: hidden;
    background: var(--t3-background) !important;
    color: var(--t3-foreground);
    font-family:
      "DM Sans",
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      system-ui,
      sans-serif !important;
  }

  body > :where(main, section, article, div):first-child {
    max-width: 100%;
  }

  :where(h1, h2, h3, h4, p, label, span, output, summary, th, td, li) {
    overflow-wrap: anywhere;
  }

  :where(h1, h2, h3, h4) {
    letter-spacing: 0 !important;
  }

  :where(button, input, select, textarea, [role="button"]) {
    border-radius: var(--t3-radius);
    font: inherit;
  }

  :where(input, select, textarea) {
    min-width: 0;
    border: 1px solid var(--t3-input);
    background: rgba(0, 0, 0, 0.22);
    color: var(--t3-foreground);
  }

  :where(button, [role="button"]) {
    border: 1px solid var(--t3-border);
    background: var(--t3-muted);
    color: var(--t3-foreground);
  }

  :where(a) {
    color: color-mix(in srgb, var(--t3-primary) 78%, white);
  }

  :where(:focus-visible) {
    outline: 2px solid color-mix(in srgb, var(--t3-primary) 75%, white);
    outline-offset: 2px;
  }

  :where(table) {
    width: 100%;
    border-collapse: collapse;
  }

  :where(img, svg, canvas, video) {
    max-width: 100%;
  }

  ::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }

  ::-webkit-scrollbar-track {
    background: transparent;
  }

  ::-webkit-scrollbar-thumb {
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.12);
  }

  ::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.2);
  }
</style>`;

function buildOrganizationPanelResizeScript(channel: string): string {
  const serializedChannel = JSON.stringify(channel);
  return `<script id="t3-organization-panel-resize">
    (() => {
      const channel = ${serializedChannel};
      let lastHeight = 0;
      const measure = () => {
        const body = document.body;
        const html = document.documentElement;
        if (!body || !html) {
          return 0;
        }
        return Math.ceil(Math.max(
          body.scrollHeight,
          body.offsetHeight,
          html.clientHeight,
          html.scrollHeight,
          html.offsetHeight
        ));
      };
      const publish = () => {
        const height = measure();
        if (height <= 0 || Math.abs(height - lastHeight) < 2) {
          return;
        }
        lastHeight = height;
        window.parent.postMessage({ type: "t3.organizationPanel.resize", channel, height }, "*");
      };
      const schedule = () => {
        window.requestAnimationFrame(publish);
      };

      window.addEventListener("load", schedule);
      window.addEventListener("resize", schedule);
      document.addEventListener("DOMContentLoaded", schedule);

      if ("ResizeObserver" in window) {
        const observer = new ResizeObserver(schedule);
        observer.observe(document.documentElement);
        if (document.body) {
          observer.observe(document.body);
        }
      }

      if ("MutationObserver" in window) {
        const observer = new MutationObserver(schedule);
        observer.observe(document.documentElement, {
          attributes: true,
          childList: true,
          subtree: true,
          characterData: true
        });
      }

      schedule();
      window.setTimeout(publish, 250);
      window.setTimeout(publish, 1000);
    })();
  </script>`;
}

function buildOrganizationPanelRpcBridgeScript(channel: string): string {
  const serializedChannel = JSON.stringify(channel);
  return `<script id="t3-organization-panel-rpc-bridge">
    (() => {
      const channel = ${serializedChannel};
      let nextRequestId = 0;
      const pending = new Map();

      window.addEventListener("message", (event) => {
        const data = event.data;
        if (
          !data ||
          data.type !== "t3.organizationPanel.rpc.response" ||
          data.channel !== channel ||
          typeof data.requestId !== "string"
        ) {
          return;
        }
        const entry = pending.get(data.requestId);
        if (!entry) {
          return;
        }
        pending.delete(data.requestId);
        if (data.ok) {
          entry.resolve(data.result);
        } else {
          entry.reject(new Error(typeof data.error === "string" ? data.error : "Dynamic RPC failed."));
        }
      });

      window.t3Panel = Object.freeze({
        rpc(method, payload = {}) {
          if (typeof method !== "string" || method.length === 0) {
            return Promise.reject(new Error("Dynamic RPC method must be a string."));
          }
          const requestId = String(++nextRequestId);
          const promise = new Promise((resolve, reject) => {
            pending.set(requestId, { resolve, reject });
          });
          window.parent.postMessage({
            type: "t3.organizationPanel.rpc.request",
            channel,
            requestId,
            method,
            payload
          }, "*");
          return promise;
        },
        runAction(method, payload = {}) {
          return this.rpc(method, payload);
        }
      });
    })();
  </script>`;
}

export function buildOrganizationPanelSrcDoc(html: string, channel: string): string {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${ORGANIZATION_PANEL_CSP}">`;
  const bodyStartInjection = buildOrganizationPanelRpcBridgeScript(channel);
  const bodyInjection = buildOrganizationPanelResizeScript(channel);

  if (/<head[\s>]/iu.test(html)) {
    const withCsp = html.replace(/<head([^>]*)>/iu, `<head$1>${cspMeta}`);
    const withHead = /<\/head>/iu.test(withCsp)
      ? withCsp.replace(/<\/head>/iu, `${ORGANIZATION_PANEL_DESIGN_STYLE}</head>`)
      : `${withCsp}${ORGANIZATION_PANEL_DESIGN_STYLE}`;
    const withBodyStart = /<body([^>]*)>/iu.test(withHead)
      ? withHead.replace(/<body([^>]*)>/iu, `<body$1>${bodyStartInjection}`)
      : `${withHead}${bodyStartInjection}`;
    return /<\/body>/iu.test(withBodyStart)
      ? withBodyStart.replace(/<\/body>/iu, `${bodyInjection}</body>`)
      : `${withBodyStart}${bodyInjection}`;
  }

  return `<!doctype html><html><head>${cspMeta}${ORGANIZATION_PANEL_DESIGN_STYLE}</head><body>${bodyStartInjection}${html}${bodyInjection}</body></html>`;
}

export function OrganizationPanelHost({ snapshot }: OrganizationPanelHostProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const channel = useId();
  const [height, setHeight] = useState(ORGANIZATION_PANEL_MIN_HEIGHT);
  const document = snapshot.panel.document;
  const srcDoc = useMemo(
    () => buildOrganizationPanelSrcDoc(document.html, channel),
    [channel, document.html],
  );

  useEffect(() => {
    setHeight(ORGANIZATION_PANEL_MIN_HEIGHT);
  }, [srcDoc]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      const data = event.data as {
        readonly type?: unknown;
        readonly channel?: unknown;
        readonly height?: unknown;
      } | null;
      if (
        !data ||
        data.type !== "t3.organizationPanel.resize" ||
        data.channel !== channel ||
        typeof data.height !== "number" ||
        !Number.isFinite(data.height)
      ) {
        return;
      }
      const nextHeight = Math.min(
        Math.max(Math.ceil(data.height), ORGANIZATION_PANEL_MIN_HEIGHT),
        ORGANIZATION_PANEL_MAX_HEIGHT,
      );
      setHeight((currentHeight) =>
        Math.abs(currentHeight - nextHeight) < 2 ? currentHeight : nextHeight,
      );
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [channel]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      const data = event.data as {
        readonly type?: unknown;
        readonly channel?: unknown;
        readonly requestId?: unknown;
        readonly method?: unknown;
        readonly payload?: unknown;
      } | null;
      if (
        !data ||
        data.type !== "t3.organizationPanel.rpc.request" ||
        data.channel !== channel ||
        typeof data.requestId !== "string" ||
        typeof data.method !== "string"
      ) {
        return;
      }

      const contentWindow = iframeRef.current?.contentWindow;
      if (!contentWindow) {
        return;
      }

      const requestId = data.requestId;
      let method: OrganizationPanelDynamicRpcMethod;
      try {
        method = OrganizationPanelDynamicRpcMethod.make(data.method);
      } catch (error) {
        contentWindow.postMessage(
          {
            type: "t3.organizationPanel.rpc.response",
            channel,
            requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          "*",
        );
        return;
      }

      void getPrimaryEnvironmentConnection()
        .client.organizationPanel.invokeDynamicMethod({
          organizationId: snapshot.organization.id,
          method,
          payload: data.payload ?? {},
        })
        .then(
          (result) => {
            contentWindow.postMessage(
              {
                type: "t3.organizationPanel.rpc.response",
                channel,
                requestId,
                ok: true,
                result: result.result,
              },
              "*",
            );
          },
          (error: unknown) => {
            contentWindow.postMessage(
              {
                type: "t3.organizationPanel.rpc.response",
                channel,
                requestId,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              },
              "*",
            );
          },
        );
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [channel, snapshot.organization.id]);

  return (
    <iframe
      ref={iframeRef}
      title={document.title}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="block w-full border-0 bg-background"
      style={{ height }}
    />
  );
}
