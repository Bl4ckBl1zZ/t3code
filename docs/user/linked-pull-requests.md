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
