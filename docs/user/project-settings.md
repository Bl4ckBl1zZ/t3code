# Customize a project icon

T3 Code checks your project configuration and common favicon paths automatically. Projects
without an image get a colored icon based on their name.

On web and desktop, open **Settings → Projects**, select a project, and use **Appearance →
Project icon**. Choose a searchable icon and color, enter an emoji, or select a project image
file. The setting applies to every checkout in the selected project group.

On iOS, select a project in the sidebar’s project filter, open that menu again, and choose
**Change project icon**. Search the icon catalogue or select an emoji, then tap **Save**.
Changes appear on your other connected clients. Icon editing requires a server that supports it.

Use **Reset** to return to automatic detection. On iOS, tap **Save** after resetting.
Project image files can be SVG, PNG, ICO, JPEG, GIF, AVIF, or WebP.

## Automatic pulls

Turn on **Automatically pull** to keep a clean default-branch checkout current.
T3 pulls only when the branch has an upstream, is behind, has no local commits,
and has no working-tree changes. Pulls only fast-forward. Feature branches and
dirty checkouts are left alone; a failed pull leaves status usable and can retry
on a later refresh.

Web and desktop expose the machine default in **Settings → General** and a
per-project choice in project settings. **Machine default** restores inheritance;
**Off** remains off even when the default is on. Group changes apply to its
checkouts on connected, supported machines. Offline machines retain their settings.

The choices are shared with other clients connected to that machine. Background refreshes respect the machine’s
background activity policy; an explicit source-control refresh also checks for a
pull. Enabled projects are also refreshed once when the server starts. The default is off.

## Worktree branch names

In **Settings → Source Control → Worktree branch naming**, choose a static prefix,
a model-selected semantic prefix such as `feat/` or `fix/`, or custom instructions
for the complete name. The static prefix defaults to `t3/`; a trailing slash is
optional, and an empty prefix adds nothing. Invalid characters in a static prefix
are replaced with hyphens. Custom instructions are appended to
the naming prompt and can specify issue IDs, namespaces, and casing.

These settings apply to automatically named new worktree branches on that machine.
Worktree directories keep their original names. If generation fails, or a custom
name is invalid or already taken, the temporary branch name remains.

## Project browser access

In project settings, **Agent browser access** can be **On**, **Off**, or
**Machine default**. The project choice overrides the machine’s browser-access
setting. Choose **Machine default** to remove an override.

Changes take effect when an agent’s next session is prepared. Turning access off
withholds its browser tools while preserving its conversation and workspace tools.
Your own browser panel remains available.

## Pull request merge method

**Pull request merge method** sets which method a pull request's merge starts with: **Merge**,
**Squash**, or **Rebase**. Web and desktop expose the machine default in **Settings → General**
and a per-project choice in project settings. On iOS, set the machine default in **Settings →
Servers → Default Merge Method**; the iOS merge sheet follows both defaults. The machine default
**Last used** keeps the method you last picked on each device; a project's **Machine default**
removes its override. Picking a
method in a pull request's menu applies to that merge and becomes your last used method. When a
repository does not allow the chosen method, the merge uses one it does.

Agents with full access can read and change these defaults through the environment preferences
tool.

## Removing agent credits when merging

**Remove agent credits when merging** removes recognized agent co-author and generated-by lines
from GitHub merge and squash commit messages. Human co-authors stay credited. It is off by
default. Web and desktop expose the machine default in **Settings → General** and a per-project
choice in project settings, where **Machine default** removes the override. It also applies to
auto-merge, but not to merge queues or stack merges. The original commits keep their messages, so a
merge commit or rebase can still carry agent credits in those commits. Agents with full access can
read and change it through the environment preferences tool.

## Defaults for new threads

On web and desktop, open **Settings → Projects**. Select **Project defaults**
to choose a default model and workspace mode, or select a project to override them.
Use the machine filter when your machines have different installed agents or models.
A change across machines requires the model to be available on each target.

Your project default and explicit draft
choices take priority; changing defaults does not change running threads.

New worktrees initialize git submodules recursively. If that step is slow because the repository
declares many nested submodules, set `"worktreeSubmodules"` in `t3.json` to `"top-level"` to stop
at the ones the repository declares itself, or `"none"` to leave them for a setup action. The
value is read from the `t3.json` of the branch being checked out.

## Worktree location

New worktrees go in the `worktrees` folder of the T3 home directory. To put them somewhere else,
such as another drive, set **Settings → General → Worktree location** to an absolute path like
`D:\worktrees` or `~/worktrees`. The setting is per machine. Existing worktrees stay where they
are, and review diffs keep working for worktrees in the default folder and in every custom folder
used before.

## Shared actions

Edits to a checkout's `t3.json`, including edits made by an agent, are picked up
automatically. Project actions sync within a few seconds. Open web, desktop, and
React Native views also refresh the file every 1.5 seconds, so configuration
changes such as preview URLs and new-thread defaults appear without reloading.

Set **Default actions** in **Settings → Projects → Project defaults** on web or
desktop. Actions
are available to projects that inherit them, and run in the selected checkout or
worktree. Setup actions run when a worktree is created; teardown actions run before
it is removed. Each project can have one of each.

Existing project actions keep working. Editing inherited actions creates a project
override; **Use machine defaults** restores inheritance. Deleting every action from
a project keeps it empty, even when machine defaults exist. Changing machine actions
does not rewrite project files. A failed save keeps the editor open for retry.

## Choose a machine automatically

Enable **Automatically balance load** in web or desktop **Settings → Connections**, or
**Balance new tasks** in iOS **Settings → Servers → Load Balancing**, shown once you have more
than one server. These preferences apply to the
client where you set them. Choose **Prefer**, **Normal**, **Less often**, or **Manual only** for
each machine.

For a new task, **Auto balance** chooses a connected machine with the same repository and
selected agent model, using available CPU and memory. The computer control shows the chosen
machine. Your draft and model choice are preserved. The machine stays selected while you write;
choosing a branch or workspace manually stops automatic rerouting.

Choose a computer directly to override Auto, or select Auto again to retry. Add attachments
after the machine is selected. If no eligible machine has available capacity, choose one
manually or retry; the task is not submitted to an arbitrary fallback machine.

## Running actions on iPhone and iPad

Open a thread’s details and choose an action. Its output opens in the terminal that
received the command. An action uses an idle shell when available and opens a separate
terminal if the existing shells are busy.

For an action marked **Single run**, its row changes to **Stop** while running. Tap it
to interrupt that action with Ctrl-C. Other terminal sessions keep running. Once the
action exits, the same row can start it again. Repeatable actions remain available to
start additional runs.

## Webhook automations

In **Settings → Schedule Tasks**, choose **On webhook** as a task's schedule to run it whenever another
service calls its URL, such as GitHub on a new pull request or a CI job that failed. After you save
the task, copy its URL from the editor. If the environment uses a [T3 Connect](remote-access.md)
managed tunnel, the URL is public; otherwise it works anywhere the environment itself is reachable.
**Rotate** replaces the URL and the old one stops working.

The prompt decides what the agent sees. Placeholders pull values out of the request:
`{{body.path}}` for a JSON or form field, `{{headers.name}}`, `{{query.name}}`, `{{body}}` for the
raw body, and `{{request}}` for everything. For example,
`Review this PR: {{body.pull_request.html_url}}` sends only the pull request link. A placeholder
with no value is left empty.

For GitHub, turn on **Require signature**, keep the header `x-hub-signature-256`, hex encoding and
the `sha256=` prefix, and enter the same secret in the repository's webhook settings with content
type `application/json`. Requests without a valid signature are rejected.

Use a webhook task's **Deliveries** button to see recent requests and the prompt each one produced.
If the environment is offline, the sender gets an error and nothing runs; redeliver from the
sender, such as GitHub's **Recent Deliveries**, once it is back.

To have T3 Connect keep requests instead, turn on **Hold webhooks while offline** in
**Settings → Connections**. T3 Connect then stores requests to a T3 Connect URL for up to 24 hours
and delivers them when the environment returns. Leave it off if you don't want request bodies
stored outside your machine. To skip requests that waited too long, set **Skip requests older
than** on the task.
