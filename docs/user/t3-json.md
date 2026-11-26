# Project configuration (`t3.json`) and actions

Check a `t3.json` file into your repository root to share project actions (setup, dev, test, and cleanup scripts), worktree defaults, icons, and multi-repo settings with everyone opening the repo in T3 Code.

## Inheritance order

Settings that `t3.json` can declare resolve in this order (first non-inherited value wins):

1. **Project override** in Settings
2. **Environment setting** in Settings
3. **`t3.json`** in the repository
4. **Built-in default**

## Schema reference

Add `"$schema": "https://t3.codes/schema/t3.json"` for editor autocomplete and validation:

```json
{
  "$schema": "https://t3.codes/schema/t3.json",
  "iconPath": "assets/logo.svg",
  "defaultThreadEnvMode": "worktree",
  "worktreeSubmodules": "top-level",
  "worktreeSparsePatternsPath": ".t3/sparse-checkout",
  "ignoreRepositories": ["vendor/big"],
  "scripts": [
    {
      "name": "Setup",
      "command": "pnpm install",
      "icon": "configure",
      "runOnWorktreeCreate": true,
      "async": false
    },
    {
      "name": "Dev",
      "command": "pnpm dev",
      "icon": "play",
      "previewUrl": "http://localhost:3000",
      "autoOpenPreview": true,
      "stopOnSettle": true
    },
    {
      "name": "Clean",
      "command": "cargo clean",
      "icon": "build",
      "runOnSettle": true
    }
  ]
}
```

### Top-level fields

| Field                        | Values / Description                                                                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iconPath`                   | Workspace-relative path to a project icon (checked before auto-detected icons).                                                                                                               |
| `defaultThreadEnvMode`       | `"local"` or `"worktree"` — default workspace mode for new threads.                                                                                                                           |
| `worktreeSubmodules`         | `"recursive"` (default), `"top-level"`, or `"none"`.                                                                                                                                          |
| `worktreeSparsePatternsPath` | Repo-relative path to a Git sparse-checkout pattern file (non-cone syntax; Git 2.35+).                                                                                                        |
| `ignoreRepositories`         | Repo-relative paths to exclude in [multi-repo projects](./multi-repo-projects.md).                                                                                                            |
| `worktreeLayout`             | Custom `{ "create": "...", "remove": "..." }` commands for multi-repo or custom worktrees (requires approval; see [Custom worktree layout](./multi-repo-projects.md#custom-worktree-layout)). |
| `scripts`                    | Up to 50 project actions (see below).                                                                                                                                                         |

## Project actions (`scripts`)

Import `t3.json` scripts or define local actions in **Settings → Projects → Actions** (run them from the thread details panel, command palette, or [keybindings](./keybindings.md) via `script.<id>.run`).

| Field                 | Description                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                | Display name in the actions menu.                                                                                                                     |
| `command`             | Shell command run in a T3 terminal at the project root.                                                                                               |
| `icon`                | `"play"` (default), `"test"`, `"lint"`, `"configure"`, `"build"`, or `"debug"`.                                                                       |
| `runOnWorktreeCreate` | Runs automatically when a new worktree is created. Skipped for agent-initiated worktrees below **Full access**.                                       |
| `async`               | For `runOnWorktreeCreate` only: `true` (default) starts the agent immediately; `false` waits for the script to finish first.                          |
| `stopOnSettle`        | Stops this action's terminal and child processes when its thread settles.                                                                             |
| `runOnSettle`         | Runs in the thread's worktree whenever the thread settles (skipped in main checkouts). Terminal closes on success, stays open on failure.             |
| `previewUrl`          | Opens this URL in the in-app browser when the script runs (desktop only).                                                                             |
| `autoOpenPreview`     | Automatically opens the browser panel at `previewUrl` on script start.                                                                                |
| `singleRun`           | **Only one run at a time**: one copy per thread, in its own terminal. Running it again restarts it.                                                   |
| `runOnWorktreeDelete` | Runs in the worktree before T3 Code deletes it, e.g. to stop containers (no terminal; stopped after two minutes; a failure never keeps the worktree). |

In the app, **Only one run at a time** matches `singleRun`, and **Run in the thread's worktree before it is deleted** matches `runOnWorktreeDelete`. A teardown script runs whenever T3 Code deletes a worktree: when you delete threads with their worktree, when storage cleanup removes it, and when an agent's worktree handoff or a thread launch is rolled back. If it fails, deleting a thread shows a warning and the storage cleanup results note the failure.

Until a project has actions of its own, T3 Code only offers `t3.json` scripts for import and never runs them on its own. Once it has its own actions (imported or created in the app), they and the file's `scripts` stay in sync within a few seconds: editing or deleting an action rewrites or removes its script (creating the file if needed), editing or removing an imported script updates the action, and a script added later becomes an action. Scripts you never imported and other fields stay untouched, and the file wins if both sides changed. **Reset** stops the sync and leaves the file as it is. Projects that already had their own actions get a `t3.json` once; if you delete it, T3 Code recreates it only on your next edit.

> Note: In multi-repo projects, only the project folder's `t3.json` is read—nested repo `t3.json` files are ignored.
