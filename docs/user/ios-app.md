# Getting around the iOS app

The native iOS app uses the standard iPhone and iPad controls. On iOS 26 and later, its bars and
sheets use the system glass material.

## Home

- **Tabs.** Home has three tabs: **Code**, **Work** and **Chat**.
- **New.** The **+** at the bottom right starts something new:
  - a **New Task** from Code;
  - a **New Conversation** from Work or Chat;
  - **Add Project** if you don't have a project yet.

  On iOS 27 the **+** sits in its own circle beside the tabs. On iPad, use the compose button in
  the toolbar or `Cmd+N`.

- **Settings.** The **T3** button at the top left opens Settings.
  - A red dot means an environment is unreachable, and an amber dot means one is reconnecting.
  - While a dot shows, the button opens **Settings → Servers**.
- **Search.** Tap the magnifying glass, or press `Cmd+F`.
- **More.** The **⋯** menu holds:
  - the project filter and **Change Project Icon…**;
  - **Select Threads** and **Arrange Threads**;
  - **Pull Requests** and **Drafts**;
  - **Add Project…**.
- **Connection problems** appear as a banner at the top of the list, with **Reconnect**. The tabs
  stay available, and threads from reachable environments keep working. Pull down on the list to
  refresh.
- **Opening the app.** Home appears right away, with placeholder rows until your environments
  respond.

## Threads

- **Header.** The thread's status, branch and environment appear under its title. Chats show
  **Chat** and the environment. On versions before iOS 26 this line sits below the title.
- **Toolbar.**
  - The **(i)** button opens the thread's details.
  - **⋯** holds pin, Files, Review, Source Control, Terminal, the linked pull request, unsnooze,
    reload and archive.
- **Scrolling.** When you scroll up, a round button above the composer jumps back to the latest
  message.
- **Failed messages.** A message that could not be sent shows **Not sent · Try Again** underneath.
  Tap it to retry.
- **Unavailable threads.** An offline, archived or unavailable thread says so, with **Reconnect**,
  **Unarchive** or **Try Again**.
- **Hardware keyboard shortcuts:**

  | Shortcut                            | Action             |
  | ----------------------------------- | ------------------ |
  | `Cmd+I`                             | Open details       |
  | `Option+Cmd+Up` / `Option+Cmd+Down` | Move between turns |
  | `Cmd+Return`                        | Send               |
  | `Cmd+.`                             | Stop the agent     |

## Thread details

- **Opening.** Details opens at half height.
- **Tools.** **Files**, **Review**, **Source Control**, **Terminal** and linked pull requests open
  inside it and expand it to full height. Tap back to return to the details.
- **Rename and delete.** Rename the thread or delete it from the thread section. Deleting asks for
  confirmation.
- **Errors.** When a git action fails, the alert names what went wrong, such as **Couldn't Push**.

## Settings

- **Layout.** Settings is a single screen with search. The server you are connected to appears at
  the top.
- **Saving.** Changes save as you make them, with no Save button. If a change can't be saved, the
  setting goes back to its previous value and the reason appears under its section.
- **Servers.** **Settings → Servers** switches, adds, removes and disconnects servers. Removing or
  disconnecting asks first.
- **Choosing a server.** Pages that belong to one server, such as **Agents**, **Project Defaults**
  and **Shared Preferences**, choose it from their title.

## Feedback

- Copying something shows a brief confirmation at the top of the screen instead of an alert.
- Haptics follow **Settings → Haptics**.
- Destructive actions such as deleting, removing or signing out always ask first.
