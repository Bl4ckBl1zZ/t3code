import { describe, expect, it } from "vitest";

import { buildOrganizationPanelSrcDoc } from "./OrganizationPanelHost";

describe("buildOrganizationPanelSrcDoc", () => {
  it("injects panel CSP, app design rules, and resize reporting", () => {
    const srcDoc = buildOrganizationPanelSrcDoc(
      `<!doctype html>
<html>
  <head>
    <title>Panel</title>
    <style>body { background: red; }</style>
  </head>
  <body><main>Content</main></body>
</html>`,
      "panel-channel",
    );

    expect(srcDoc).toContain("Content-Security-Policy");
    expect(srcDoc).toContain('id="t3-organization-panel-design"');
    expect(srcDoc).toContain('id="t3-organization-panel-rpc-bridge"');
    expect(srcDoc).toContain('id="t3-organization-panel-resize"');
    expect(srcDoc).toContain('"t3.organizationPanel.resize"');
    expect(srcDoc).toContain("window.t3Panel");
    expect(srcDoc.indexOf("body { background: red; }")).toBeLessThan(
      srcDoc.indexOf('id="t3-organization-panel-design"'),
    );
    expect(srcDoc.indexOf('id="t3-organization-panel-rpc-bridge"')).toBeLessThan(
      srcDoc.indexOf("<main>Content</main>"),
    );
    expect(srcDoc.indexOf('id="t3-organization-panel-resize"')).toBeLessThan(
      srcDoc.indexOf("</body>"),
    );
  });
});
