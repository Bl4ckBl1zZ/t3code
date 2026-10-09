# Browser previews

A floating browser preview lets you watch a page while continuing a conversation. Drag it to
move it, or resize it from any edge or corner. Its proportions follow the page viewport. Opening
the same tab in the full browser panel temporarily hides the floating preview; closing the panel
brings it back. Automatic floating previews follow your browser preference and an agent's
explicit request to keep a tab in the background.

Browser recordings keep a copy on your desktop. When an agent requests a recording, it is
also uploaded to that conversation's environment so the agent can read it over a remote
connection. Recordings up to 50 MB are supported. If a transfer fails, the desktop copy remains
available; retry or make a shorter recording. Keep both desktop and server updated for remote
recording support.

On desktop, **Settings → Integrations** can show key presses and mouse presses in new
recordings. Both are off by default, and password fields are never shown. The recorded cursor
follows the page's own pointer, so it stays aligned with what was clicked.

Agents get text-only page snapshots unless they ask for an image, so screenshots do not pile
up in the conversation history. Large text responses are bounded, while structured page metadata
remains available for precise page inspection.

The address bar opens what you type as an address when it looks like one (`localhost:5173`,
`example.com`) and searches the web otherwise. On desktop, a link that opens a new tab opens as
another browser tab of the same thread; middle-click or Cmd-click opens it in the background.
A page that goes fullscreen fills its tab instead of the whole window, and a page that tries to
open another app (such as a `slack://` link) asks first. Deleting a thread closes its browser
tabs.
