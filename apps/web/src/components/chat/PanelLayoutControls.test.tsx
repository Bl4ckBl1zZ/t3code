import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PanelLayoutControls } from "./PanelLayoutControls";

describe("PanelLayoutControls", () => {
  it("keeps unavailable panel tooltip triggers interactive", () => {
    const markup = renderToStaticMarkup(
      <PanelLayoutControls
        showTerminalControl
        // The thread-details control renders its own tooltip trigger; this test
        // is about the two panel toggles that can be disabled.
        showThreadPanelControl={false}
        terminalAvailable={false}
        terminalOpen={false}
        terminalShortcutLabel={null}
        threadPanelOpen={false}
        threadPanelPresentation="inline"
        threadPanelShortcutLabel={null}
        threadPanelHasAttention={false}
        rightPanelAvailable={false}
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        liveAgentCount={0}
        onToggleTerminal={() => {}}
        onToggleThreadPanel={() => {}}
        onToggleRightPanel={() => {}}
      />,
    );

    expect(markup.match(/data-slot="tooltip-trigger"/g)).toHaveLength(2);
    expect(markup.match(/data-slot="tooltip-trigger"[^>]*><button[^>]*disabled=""/g)).toHaveLength(
      2,
    );
  });
});
