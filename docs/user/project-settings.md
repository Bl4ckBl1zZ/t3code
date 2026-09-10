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
