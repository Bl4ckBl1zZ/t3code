# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
`mod+shift+p` pins or unpins the thread you have open. Pinned threads are shown independently of
their project, including when you connect to more than one environment.

To require confirmation before unpinning, enable **Settings → Preferences → Confirm before
unpinning**. Web and desktop apply it to the sidebar controls and `mod+shift+p` shortcut.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

When you un-settle a thread, it returns to the top of the active list so you can find it right
away. Its timestamps do not change. Other threads keep their positions.

A thread whose composer holds unsent text or attachments shows an amber tint and a pen icon in the
sidebar, the same marks a new-thread draft uses. On web and desktop, hover the row and choose the
**X** to discard that draft without opening the thread.

Right-click a pull request link in a thread and choose **Link to thread** to show that pull request
in the sidebar. The thread settles when the linked pull request merges if **Auto-settle merged
threads** is enabled. Right-click the same link and choose **Unlink from thread** to remove it.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current scroll
position instead of following the thread to its new place in the list.

On web and desktop, unpinning, settling, snoozing, and archiving a thread each show a notice at
the bottom of the sidebar with **Undo** for five seconds. Undo restores the thread's previous
state, including its pinned position, and reopens an archived thread you were viewing. `mod+z`
triggers the most recent Undo when no text field is focused; see [Keybindings](./keybindings.md).

On web and desktop, hover a thread to see where it runs, which model it uses, and -- when it has
changed agents -- which ones it ran on before. The elapsed time beside a working thread counts from
the moment that turn started, including while it waits for your approval, and disappears once the
thread stops working.

## Delete threads on web and desktop

Choose **Delete** from a thread's menu, or select several threads and choose **Delete (N)**. With
**Settings → General → Delete confirmation** on, T3 Code asks once before deleting. If the deleted
threads were the only ones using a worktree, it then asks once whether to delete those worktrees
too, however many threads you selected. With the setting off, threads are deleted without asking
and their worktrees are kept. To clean up settled threads automatically, see
[Auto-delete settled threads](#auto-delete-settled-threads).

## Snooze until later

On web and desktop, choose **Snooze → Custom…** from a thread's menu, the chat header menu, or a
multi-thread selection to pick a date and time in your local time zone, or a duration in minutes,
hours, or days. Durations start when you confirm; one day means 24 hours. Choose **Wake thread**
to bring a thread back early.

## Search and filter on web and desktop

Sidebar search matches message content as well as titles. Title matches come first; content
matches show a short excerpt. Right-click a thread and choose **Filter by project** to show only
that project's threads, and **Show all projects** to clear the filter.

## Thread notifications on web and desktop

**Settings → General → Thread notifications** is off by default. Choose notifications, sound, or
both to hear about a thread that finishes, fails, or needs input or approval while T3 Code is
open. System notifications need a secure browser context or the desktop app, and your permission.
**In-app notifications** shows a toast for other threads while the app has focus. Both settings
apply to the current device.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.

## Native iOS draft and batch actions

Threads with unsent text or attachments show a **Draft** badge. Long-press a thread and choose
**Discard draft** to clear it after confirmation, including when its composer is open.

Choose **⋯ → Select Threads** on Home, choose **Select** from a row’s menu, or swipe across rows
with two fingers, then select rows to snooze, settle, archive, pin or unpin, or delete together from
the bar at the bottom. Each action is available when it applies to at least one selected thread.
Delete asks for confirmation; unpin follows your confirmation preference.
Successful rows leave the selection. Failed rows stay selected so you can retry. Deleting thread
history does not remove worktree files from the environment. Threads that cannot be snoozed,
such as queued threads or Work's Main thread, stay selected when you snooze a selection.

On iOS, **Snooze → Custom…** in a thread's menu or in the selection bar opens a sheet for a
date and time in your device's time zone, or a duration in minutes, hours or days. Durations
start when you tap **Snooze**.

On iOS, swipe a Home row from the left to pin or snooze it, or from the right to settle or delete
it. Delete asks for confirmation. A thread that is still running can't be archived; its menu says
why.

On iOS, unpinning, settling, snoozing, and archiving a thread show a notice at the bottom of Home
with **Undo** for five seconds. Several of the same action in a row, such as a batch settle, undo
together. Undo restores the thread's previous state, including its pinned position. Shaking the
device, or pressing ⌘Z on an iPad keyboard, triggers the same Undo.

Tap the magnifying glass on Home to search. Choose **Code**, **Work** or **Chat** under the search
field to change what you search; it starts on the tab you are in. Home search also matches message
content on connected environments. Title, project and pull request matches come first; message
matches follow in a **Messages** section with the matching line under the row.

## Arrange active threads on native iOS

On supporting environments, choose **⋯ → Arrange Threads** on the Code or Work tab. Drag
the handles, or use VoiceOver's **Move up** and **Move down** actions. The order is saved to the
environment, so other connected devices see it too. Project filters leave other threads alone.
New and reopened threads appear above arranged threads. **Reset to Newest First** removes the
manual order for the displayed active threads. Pinned threads retain their separate order.

On web and desktop, drop files onto a thread row or search result to open that thread and attach
the files to its draft. This works in either sidebar layout. Files use the same validation and
upload controls as files dropped onto the conversation; dropping never sends a message.

The chat header also offers thread actions from its title menu. Double-click the title to rename it; Enter saves and Escape cancels. The menu includes the supported pin, settle, snooze, copy, archive, and delete actions. Click the project breadcrumb to open project settings.

## Arrange active threads on web and desktop

Drag an active thread within its section to choose its position. On current servers, the order
is saved to the environment and shared with native iOS. New and reopened threads appear above
arranged active threads. Choose **Reset thread position** from a thread’s menu to return it to
automatic ordering. Pinned threads have their own order, and Work’s main thread stays fixed.

Older servers keep local-only drag ordering. If a section mixes older servers with threads that
already have synced positions, update those servers before reordering the section.

## Drop files onto a native thread

On iPad, drag files from another app onto a thread row to open its composer with those files.
Existing text and attachments stay in place, and the message remains unsent. Preparation uses
the same file-size and eight-attachment limits as the composer. If you leave while files are
being prepared, return to that thread to finish adding the pending files during this app session.
Archived rows and batch-selection mode do not accept drops.

## Automatic organization

Current servers move finished or inactive threads into **Settled** even when no client is open.
These settings belong to the selected environment and apply to every connected device. Configure
merge settlement or an inactivity period from 1 to 90 days on web or desktop. Turn off inactivity settlement to keep quiet threads
active indefinitely. Older servers keep their existing device-local behavior.

Running or queued work, blocking approvals and unanswered blocking questions stay visible.
Asynchronous questions do not block the thread. Open linked pull requests keep their thread active;
a stack is not finished until every visible linked request is terminal. A merge or close from before
your latest engagement does not settle resumed work again. Manually reopen any settled thread to
bring it back to the active list. Automatic settlement retains its pin and ordering metadata.

To keep one thread out of **Settled** no matter how long it sits idle, open its menu, choose
**Auto-settle behavior**, and pick **Disabled**. On iOS, long-press the thread on Home to open the
menu. The current option is checked. Pick **Enabled** to return to the usual rules. Manual settle,
snooze, and archive still work while it is disabled.

### Auto-delete settled threads

**Settings → General → Auto-delete settled threads** is off by default. When you turn it on, the
selected environment permanently deletes threads that have stayed in **Settled** for the number of
days you choose (1 to 365, 30 by default). The days count from when the thread moved to
**Settled**. Threads that were already settled longer than that are deleted within a minute of
turning the setting on.

Deleting a thread this way also removes its worktree and its local branch, even when the worktree
has uncommitted changes or the branch was never merged. A worktree or branch that another thread
still uses is kept. Threads that run in the project folder itself only lose the conversation.

Pinned and archived threads are never deleted automatically, so pin a settled thread to keep it.
Reopening a thread takes it out of **Settled** and stops its countdown; if it settles again, the
count starts over. During the final week, a settled row shows a trash icon with the time left, such
as **2d**, in place of its age.

Pull requests created or opened through a thread’s Git actions are automatically linked to that
thread. They appear in its pull-request collection, including requests targeting an upstream
repository. Existing manual links keep their labels. Actions from an unsent draft have no saved
thread to attach to.

Open **Linked pull requests** from a thread’s link or stack badge to review its full collection
beside the conversation. The panel shows checks, reviews, conflicts and stack order from the
latest saved host state. Rows name the repository when the thread links requests from more than
one. Open individual requests in separate tabs, copy their links, or unlink them from the row menu. The right-panel launcher opens this collection even before a request
has been linked.

Thread and source-control preferences are shared across connected machines. On native iOS,
open **Settings → Shared preferences**; on web or desktop, use **General** and **Source Control**.
If a machine was offline during an edit, a mismatch notice lets you apply the selected machine’s
preferences to the others. Provider accounts, project overrides and machine configuration remain
specific to each machine. A generated-text model only propagates to compatible enabled accounts.
