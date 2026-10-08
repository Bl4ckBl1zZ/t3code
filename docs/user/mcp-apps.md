# MCP apps

Some MCP servers return an interactive app with their tool results, following the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) standard. When an agent calls one of those tools, the app appears in the thread in place of the tool call, on web, desktop and the iOS app. Codex supports this today, for any MCP server you have configured for it; other providers show these calls as ordinary tool calls. Connected to a server too old to run apps, the iOS app shows them as ordinary tool calls too.

Apps follow your theme. An app can call tools on its own server and post a message to the thread; T3 Code asks first unless the server marks the tool as read-only, and it asks before every message and before saving a file an app offers. Links open only from a click inside the app; on iOS, T3 Code asks before opening one. An app can copy to your clipboard if it asks to, but it never gets your camera, microphone, or location. An app that navigates away from its own page is stopped.

An app stays viewable after its agent stops, but using it needs the agent of the thread that created it running, so send a message in that thread first if the app says it is unavailable. Deleting the thread deletes its apps.

An app can open full screen; use the button in its top corner, or press Escape outside the app, to return it to the thread. Anything else that needs your attention, such as an approval, also returns it to the thread. An app can also keep the agent informed of what you did in it, such as a filter you picked; T3 Code sends the latest note from each app with your next message.

On iOS, an app sits in a fixed-height box in the thread and scrolls inside it. Full screen opens the app in its own screen; close it to return the app to the thread, where it starts again from the beginning. Something the agent needs from you, such as an approval, also closes full screen. A saved file opens the share sheet, so you choose where it goes. An app reloads when you scroll far away from it and back.
