# Linked pull requests on iOS

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
