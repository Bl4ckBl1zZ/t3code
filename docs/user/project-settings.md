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

On iOS, open **Settings → Project defaults**, choose a machine, and change
its default or individual project overrides. The choices are shared with other
clients connected to that machine. Background refreshes respect the machine’s
background activity policy; an explicit source-control refresh also checks for a
pull. Enabled projects are also refreshed once when the server starts. The default is off.

## Project browser access

In project settings, **Agent browser access** can be **On**, **Off**, or
**Machine default**. The project choice overrides the machine’s browser-access
setting. On iOS, **Settings → Project defaults** contains both the machine default
and project overrides. Choose **Machine default** to remove an override.

Changes take effect when an agent’s next session is prepared. Turning access off
withholds its browser tools while preserving its conversation and workspace tools.
Your own browser panel remains available.

## Defaults for new threads

On web and desktop, open **Settings → Projects**. Select **Project defaults**
to choose a default model and workspace mode, or select a project to override them.
Use the machine filter when your machines have different installed agents or models.
A change across machines requires the model to be available on each target.

On iOS, open **Settings → Project defaults**, select a machine, and choose the
model or **Local** / **New worktree** workspace. **Use automatic model selection**
clears the machine's model preference. Your project default and explicit draft
choices take priority; changing defaults does not change running threads.

## Shared actions

Set **Default actions** in **Settings → Projects → Project defaults** on web or
desktop. In iOS **Settings → Project defaults**, use **Machine actions**. Actions
are available to projects that inherit them, and run in the selected checkout or
worktree. Setup actions run when a worktree is created; teardown actions run before
it is removed. Each project can have one of each.

Existing project actions keep working. Editing inherited actions creates a project
override; **Use machine defaults** restores inheritance. Deleting every action from
a project keeps it empty, even when machine defaults exist. Changing machine actions
does not rewrite project files. A failed save keeps the editor open for retry.

## Choose a machine automatically

Enable **Automatically balance load** in web or desktop **Settings → Connections**, or
**Balance new tasks** in iOS **Settings → Load balancing**. These preferences apply to the
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
