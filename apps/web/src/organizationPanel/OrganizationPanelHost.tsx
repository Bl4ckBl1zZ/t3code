import type { OrganizationPanelSnapshot } from "@t3tools/contracts";
import { useMemo } from "react";

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

function buildOrganizationPanelSrcDoc(html: string): string {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${ORGANIZATION_PANEL_CSP}">`;

  if (/<head[\s>]/iu.test(html)) {
    return html.replace(/<head([^>]*)>/iu, `<head$1>${cspMeta}`);
  }

  return `<!doctype html><html><head>${cspMeta}</head><body>${html}</body></html>`;
}

export function OrganizationPanelHost({ snapshot }: OrganizationPanelHostProps) {
  const document = snapshot.panel.document;
  const srcDoc = useMemo(() => buildOrganizationPanelSrcDoc(document.html), [document.html]);

  return (
    <iframe
      title={document.title}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="block min-h-[28rem] w-full border-0 bg-background"
    />
  );
}
