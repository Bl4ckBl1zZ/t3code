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

- **No project.** In a new task, the project menu lists **No Project** right after the current
  project, or first when none is chosen, once for each connected machine that keeps a folder for
  tasks outside any repository. Choosing it starts the task in that folder.
- **Settings.** The **T3** button at the top left opens Settings.
  - A red dot means an environment is unreachable, and an amber dot means one is reconnecting.
  - While a dot shows, the button opens **Settings → Servers**.
- **Search.** Tap the magnifying glass, or press `Cmd+F`. Search fields throughout the app don't
  autocorrect or capitalize, so names, branches and paths stay as you type them.
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
  Tap it to retry. Above the composer, a notice says why the message was not sent, with **Retry**
  and a close button. It stays with the thread until you dismiss it, send again, or the message
  goes out.
- **Failed setup.** When preparing a new task's workspace fails, for example creating its
  worktree, the error offers **Retry setup**. It prepares the workspace again and then starts the
  task, without sending your message twice.
- **Unavailable threads.** An offline, archived or unavailable thread says so, with **Reconnect**,
  **Unarchive** or **Try Again**.
- **Agents.** An agent's row shows its model, the provider account when you have more than one,
  and its project, branch or folder when they differ from the thread's, with up to three lines of
  its latest progress or result. Tap it to open the agent's thread; Back returns to the thread that
  started it.
- **MCP apps.** A tool call that returns an [MCP app](mcp-apps.md) shows the app in the thread.
  It asks before running a tool that changes something, sending a message, opening a link or
  saving a file. An app can open full screen; close it to return to the thread.
- **Hardware keyboard shortcuts:**

  | Shortcut                            | Action                                  |
  | ----------------------------------- | --------------------------------------- |
  | `Cmd+I`                             | Open details                            |
  | `Option+Cmd+Up` / `Option+Cmd+Down` | Move between turns                      |
  | `Cmd+Return`                        | Send                                    |
  | `Option+Cmd+Return`                 | Send, then start a new task             |
  | `Cmd+.`                             | Stop the agent                          |
  | `Shift+Cmd+H`                       | In a new task, move to the next machine |

## Thread details

- **Opening.** Details opens at half height.
- **Tools.** **Files**, **Review**, **Source Control**, **Terminal** and linked pull requests open
  inside it and expand it to full height. Tap back to return to the details.
- **Review.** Review opens on **Changes**: everything on the branch since it left its base,
  including what is not committed yet. Switch to **Uncommitted** from its **⋯** menu.
- **Watching pull requests.** In **Linked Pull Requests**, an open pull request's menu offers
  **Watch for Changes**. The agent then wakes when checks finish, someone comments, or the branch
  conflicts, and the row reads **Watching** until you choose **Stop Watching**.
- **Rename and delete.** Rename the thread or delete it from the thread section. Deleting asks for
  confirmation.
- **Errors.** When a git action fails, the alert names what went wrong, such as **Couldn't Push**.

## Settings

- **Layout.** Settings is a single short screen: the server you are connected to, your default
  model, and this device's appearance, chat, notification, voice and haptics preferences. Agent
  accounts, projects, integrations and other server settings are in T3 Code on your computer.
- **Agents.** **Install or Sign In** names an agent that needs installing or signing in again and
  opens its setup.
- **Saving.** Changes save as you make them, with no Save button. If a change can't be saved, the
  setting goes back to its previous value and the reason appears under its section.
- **Servers.** **Settings → Servers** switches, adds, removes and disconnects servers. Removing or
  disconnecting asks first.
- **Permissions.** A server that gives Files, Git, settings and other features their own permissions
  keeps a device paired before that on its old ones. Its row and details page then say new
  permissions are available. **Pair Again** opens Add Server for a new pairing code from that
  server; a T3 Connect server shows **Renew Access** instead, which needs no code. Until then those
  features say to pair the device again.
- **Notifications.** **Settings → Notifications** chooses which events alert you: a task that needs
  your input, finishes, or fails. Tapping a notification opens its thread, waiting for it to load if
  it was started elsewhere.
- **Automations and Work.** **Automations**, and **Work Settings** on the Work tab, are in Home's
  **More** menu.

## Feedback

- Copying something shows a brief confirmation at the top of the screen instead of an alert.
- Haptics follow **Settings → Haptics**.
- Destructive actions such as deleting, removing or signing out always ask first.
