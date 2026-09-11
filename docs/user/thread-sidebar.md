# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
`mod+shift+p` pins or unpins the thread you have open. Pinned threads are shown independently of
their project, including when you connect to more than one environment.

To require confirmation before unpinning, enable **Settings → Preferences → Confirm before
unpinning**. On native iOS, the confirmation applies to list swipes, thread menus, and the thread
details sheet. Web and desktop also apply it to the sidebar controls and `mod+shift+p` shortcut.

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

Tap **Select threads** or choose **Select thread** from a row’s menu, then select rows to unpin
or delete together. Delete asks for confirmation; unpin follows your confirmation preference.
Successful rows leave the selection. Failed rows stay selected so you can retry. Deleting thread
history does not remove worktree files from the environment.

## Arrange active threads on native iOS

On supporting environments, choose **Arrange threads** above the Code or Work task list. Drag
the handles, or use VoiceOver's **Move up** and **Move down** actions. The order is saved to the
environment, so other connected devices see it too. Project filters leave other threads alone.
New and reopened threads appear above arranged threads. **Reset to newest first** removes the
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
These settings belong to the selected environment and apply to every connected device. On native
iOS, open **Settings → Thread organization**, choose the machine, and configure merge settlement
or an inactivity period from 1 to 90 days. Turn off inactivity settlement to keep quiet threads
active indefinitely. Older servers keep their existing device-local behavior.

Running or queued work, blocking approvals and unanswered blocking questions stay visible.
Asynchronous questions do not block the thread. Open linked pull requests keep their thread active;
a stack is not finished until every visible linked request is terminal. A merge or close from before
your latest engagement does not settle resumed work again. Manually reopen any settled thread to
bring it back to the active list. Automatic settlement retains its pin and ordering metadata.

Pull requests created or opened through a thread’s Git actions are automatically linked to that
thread. They appear in its pull-request collection, including requests targeting an upstream
repository. Existing manual links keep their labels. Actions from an unsent draft have no saved
thread to attach to.
