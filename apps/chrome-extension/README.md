# T3 Code Browser Transfer

This is an unpacked Chrome extension for the desktop-only **Transfer to Browser** action.

Load it in Chrome from `chrome://extensions` with Developer Mode enabled, choosing this
`apps/chrome-extension` directory.

The extension listens for T3 Code transfer URLs on loopback hosts, opens the inferred dev server
URL in the same Chrome window, and groups the T3 Code and dev server tabs together.

When the linked T3 Code browser tab is focused, the chat header shows a cursor button. Clicking it
focuses the linked dev server tab and enables annotation mode. Click a page element, type an
annotation, and press Enter to send the cropped highlighted screenshot plus text into the focused
T3 Code chat.

The extension requests `<all_urls>` because Chrome requires either that permission or `activeTab`
for `tabs.captureVisibleTab()`. Content scripts still only run on loopback T3/dev URLs, and the
service worker only accepts annotation screenshots from a dev tab linked by a transfer.

Chrome exposes tab grouping through the public extension APIs. Native Chrome Split View currently
does not expose a public extension method for creating a split view, so the extension prepares the
paired group and leaves native split activation to Chrome/user support when that API becomes
available.
