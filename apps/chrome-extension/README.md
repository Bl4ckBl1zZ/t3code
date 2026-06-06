# T3 Code Browser Agent

This is an unpacked Chrome extension that connects Chrome with a T3 Code backend over the
browser-agent WebSocket.

In development, run `pnpm dev:desktop` and load the stable app-data extension folder from
`chrome://extensions` with Developer Mode enabled. On macOS dev builds this is usually
`~/Library/Application Support/t3code-dev/Chrome Extension`. The dev runner keeps that folder in
sync with `apps/chrome-extension` and the extension reloads itself after synced changes.

For one-off extension development without the desktop dev runner, load this `apps/chrome-extension`
directory directly.

After pulling a newer packaged T3 Code build, click the extension icon and choose **Reload
extension**. For the manual Chrome path, open `chrome://extensions`, find **T3 Code Browser Agent**,
and click the reload button. Reloading keeps the saved pairing credentials and reconnects the
browser-agent WebSocket.

The normal host-machine path is automatic: click **Preview** in T3 Code. If no browser agent is
connected yet, T3 Code asks this extension to try the desktop loopback `/browser-agent/local-ws`
socket first. If local control is unavailable, T3 Code creates a bearer alias for the current
session, opens the backend's `/browser-agent/auto-pair` URL in the default browser, and this
extension consumes that session token before the preview command is retried. This fallback works for
owner and non-owner remote sessions.

Manual pairing is still available from the extension icon for remote browsers or debugging. Enter a
reachable T3 Code backend URL plus a pairing token from the app.

After connecting, **Preview** sends a backend command to the extension. The extension opens or
focuses the matching dev-server tab, groups it by repo name, collapses the group, records that tab
as the active workspace, and serves the T3 Code chat from Chrome's native side panel. Agent-created
thread tabs use the same collapsed tab-group behavior. If Chrome does not open the side panel
automatically, click the extension icon in the preview window.

When the browser is paired and the active tab is not a linked preview tab, clicking the extension
icon opens the paired T3 Code backend URL instead.

The cursor button in T3 Code sends an annotation command through the backend. The extension focuses
the linked preview tab, lets you click an element, captures a cropped screenshot around the
highlighted element, and sends the annotation back to the backend. The backend appends the
annotation as a new chat message with the screenshot attachment.
