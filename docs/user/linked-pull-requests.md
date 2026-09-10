# Linked pull requests

Open a task's Details, then Version Control → Linked pull requests. Add a PR number
or paste its URL to link a request from the task's repository. Add more requests
in the same sheet, tap one to read it, or unlink a request without closing it on
the host. Search tasks by PR number (`#42`), repository, or PR URL.

A task with multiple links stays active while any linked request is open or its
status is unavailable. Automatic settlement still respects your settle-on-merge
preference. Older servers offer one linked request instead.

For a GitHub PR that belongs to a stack, its detail screen lists the layers from
base to top. Tap a layer to read it. If your account has permission, review a
merge through the selected layer or a rebase from the top layer. The confirmation
lists the affected revisions before you submit. These operations update GitHub;
they do not switch or rewrite your local checkout.

If a stack changed since you reviewed it, refresh before retrying. A rebase can
stop after updating earlier layers; those completed updates remain on GitHub.
If GitHub reports that a merge is still running, check its status before submitting
another request. Stack controls require a server and host that support them.

On web and desktop, the link button beside the thread title lists all linked requests.
Choose **Link** there or **Link pull request** in the command palette. Bare numbers
use the current project's repository; a full URL can link another repository with a
readable project in the same environment. Unlinking removes the association without
changing the request on its host.

In GitHub PR details, open **Stack** to browse layers, refresh their state, or review
a merge/rebase. The confirmation captures the revisions you reviewed. A failure
requires closing and refreshing before another attempt.

Choose **Change labels** in a GitHub PR’s summary to search repository labels and
apply or remove them. Applied labels show a checkmark. Editing needs triage access
and a server that supports it. The list loads when opened; if the repository has
more labels than the list can show, use GitHub for the remainder.

The web pull-request list remembers your filters and sort order when reopened from the sidebar.
The default **Ready to merge** order puts approved, passing work first, then passing work awaiting
review. Conflicts stay last. Smaller measured diffs sort first within each readiness group.
Searching keeps relevance ordering, and changing a filter leaves your current review open.
Project choices combine checkouts of the same repository on one machine and distinguish
matching names across machines.

On iOS, choose **Pull requests** below the Code sidebar’s project filter to browse across your
connected environments. Open **Filters and sorting** to choose an environment, project, host,
state, involvement, draft/review/check status, author, or labels. Filters and sort order are
remembered. Pull down to refresh, or choose **Load more** for older requests.

Your authored requests and requested reviews are fetched separately from the general feed so
older work can still appear in those groups. Unavailable hosts show an explanation while other
results remain readable. Some hosts search only loaded rows; the list identifies those hosts.
Unknown change sizes stay blank until loaded. Long-press a row to copy its link or open its host.
Tap a row for the existing summary, conversation, labels and reviewed stack actions.

On hosts that provide diffs, the iOS **Code** tab shows changed files in a collapsible folder tree.
Filter by path, choose all commits or a single commit, then tap a file to read its line diff.
Use **Copy path** in the file toolbar. **Load more files** continues large diffs; a notice identifies
hunks or binary contents withheld by the host. File counts retain the host’s reported values even
when its patch omits the text. Refresh retries failed reads without changing the local checkout.

On iOS, tap a changed line in **Code → All commits** to add a private line comment. Choose
**Review** to edit or remove pending comments, write a summary, and submit a comment, approval,
or request for changes where your host and account allow it. Drafts stay on this device when you
close the sheet. Failed submissions preserve them; successful submissions clear only what was sent.

Review conversations appear in **Timeline** and beside their matching lines in the Code view.
Older or out-of-hunk conversations stay separate from current code. Expand a resolved conversation
to read it, load more comments, reply, or reopen it when permitted. Replies preserve your text when
sending fails, and resolving a conversation can be undone with **Reopen conversation**.

In an iOS PR file, **Show full file context** reads the host’s previous and new versions for the
selected comparison. **Show changed hunks** returns to the compact diff. If the PR changed while
you were reading, refresh it before expanding. When the host withheld the hunks, you can switch
between labelled previous and new file versions; those snapshots are not presented as a diff.

The iOS **Actions** menu offers the operations your host and account allow: merge, mark ready,
convert to draft, close/reopen, update the branch, and enable/disable auto-merge. Merge choices
follow repository settings. Review the target branch and method before merging or updating;
auto-merge can finish immediately when the host’s requirements already pass. Conflict, base
freshness and enabled auto-merge status appear below the PR heading.

**Refresh from host** reloads current details and code. Pulling down in the PR workspace refreshes
its host listings, including the signed-in identity and change counts.

On iOS, **Edit pull request** changes the title or description when your host and permissions allow
it. Saving one leaves the other untouched, and an empty description clears it. In **Timeline**, use
**Add comment** to post a remark. Your own editable remarks have **Edit comment**, including those
inside review conversations. Failed saves keep the editor’s text so you can retry.

Reaction pills on iOS show each host count and whether you reacted. Tap a pill to add or remove your
reaction, or open the smile menu to choose another. Long-press a pill to see the reported names.
The count updates while saving and returns to its previous state if the host refuses the change.
