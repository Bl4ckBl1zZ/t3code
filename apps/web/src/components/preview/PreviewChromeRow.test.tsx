import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { PreviewChromeRow } from "./PreviewChromeRow";

function renderRow(props?: Partial<Parameters<typeof PreviewChromeRow>[0]>): string {
  return renderToStaticMarkup(
    <PreviewChromeRow
      url="http://localhost:3000"
      loading={false}
      loadProgress={0}
      canGoBack={false}
      canGoForward={false}
      onBack={vi.fn()}
      onForward={vi.fn()}
      onRefresh={vi.fn()}
      onSubmit={vi.fn()}
      {...props}
    />,
  );
}

describe("PreviewChromeRow device toolbar quick action", () => {
  it("renders a show toggle when the viewport fills the panel", () => {
    const markup = renderRow({ onToggleDeviceToolbar: vi.fn(), deviceToolbarActive: false });
    expect(markup).toContain('aria-label="Show device toolbar"');
    expect(markup).toContain('aria-pressed="false"');
  });

  it("renders a pressed hide toggle while the device toolbar is active", () => {
    const markup = renderRow({ onToggleDeviceToolbar: vi.fn(), deviceToolbarActive: true });
    expect(markup).toContain('aria-label="Hide device toolbar"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it("omits the toggle when no handler is provided", () => {
    const markup = renderRow();
    expect(markup).not.toContain("device toolbar");
  });
});
