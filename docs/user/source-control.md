# Source Control Integrations

T3 Code connects to your Git hosting provider so you can create pull requests, review code, and manage repositories without leaving the app.

## Supported Providers

T3 Code works with the platforms your team already uses:

- **GitHub** – Pull requests, repository creation, and clone integration
- **GitLab** – Merge requests, repository publishing, and hosted clones
- **Bitbucket** – Pull request workflows (via access or API token authentication)
- **Azure DevOps** – Pull request support for Microsoft-hosted repositories

## What You Can Do

### Start Projects from Anywhere

**Start from a name**

- Open the Command Palette (`Cmd/Ctrl + K`) → **New project**, or **Add Project** → **New project**, and type a name
- T3 Code makes a Git repository in `~/.t3/projects` (the `projects` folder of your T3 data directory) with a README, an icon, and a first commit, then opens a new thread in it. The folder is named after the project, like `pinball-stats` for "Pinball Stats"
- Turn on **Create private repository on GitHub** to also publish it. If Git has no name or email on that machine, the project is created without the first commit

**Clone repositories directly**

- Open the Command Palette (`Cmd/Ctrl + K`) → **Add Project**
- Choose **GitHub repository**, **GitLab repository**, **Bitbucket repository**, **Azure DevOps repository**, or paste any **Git URL**
- Enter the repository path (`owner/repo`, `group/project`, `workspace/repository`, or `project/repository`) or a full Git URL, pick a destination, and start coding

**Publish local projects to the cloud**

- Have a local Git repository without a remote?
- Use the **Publish Repository** action to create a new hosted repository (GitHub, GitLab, Bitbucket, or Azure DevOps), add it as your origin remote, and push, in one flow
- If the local repository has no commits yet, publishing creates the remote and wires it up but does not push. Make a commit, then push normally.

### Manage Code Reviews Without Context Switching

**Create pull requests while you work**

- Push a branch and create a pull request from the Git actions controls in the toolbar
- T3 Code can suggest titles and descriptions based on your commits
- With **Repository conventions** selected, generated source control text follows the project's
  `AGENTS.md` along with recent commit subjects. Claude writers also follow `CLAUDE.md`
- Supports GitHub Pull Requests, GitLab Merge Requests, Bitbucket Pull Requests, and Azure DevOps Pull Requests

**Stay on top of open reviews**

- See if your current branch already has an open PR/MR
- Open several reviews from the **Pull requests** page as tabs in the right panel
- Filter the list by author or labels, rank authors by merges in the loaded results, see label and
  change-size context on each row, and sort the results currently shown by update time, creation
  time, or change size
- While working in a thread, open linked reviews in the same compact right-panel tabs without
  leaving the conversation
- Open the review directly in your browser with one click
- If T3 Code cannot load a GitHub pull request, including when GitHub rate limits requests, use
  **Open on GitHub** in the error view
- Command-click (Control-click on Windows and Linux) a pull request number in the sidebar to open it in your browser instead of in T3 Code
- Check out a teammate's branch to review code locally

**Fix what you wrote, in place**

- Rewrite a pull request's title and description from the review itself, in Markdown, with a
  preview before you save
- Rewrite your own comments the same way, wherever they are shown
- Works on GitHub, GitLab, and Bitbucket. Azure DevOps takes a new title and description; its
  comments stay read-only here, as they already were

### Know Your Setup at a Glance

The **Source Control settings** page shows you exactly what's connected:

- ✅ Which providers are authenticated and ready
- ⚠️ What's missing and how to fix it
- 👤 Which account is signed in (when available)

Run a quick **Rescan** after setting up a new machine or changing credentials.

## Getting Started

### For GitHub (Recommended for most users)

T3 Code talks to GitHub's API directly and only needs a token. Any of these works, in this
order of precedence:

1. A token saved in **Settings → Source Control → GitHub**. It is kept in the server's secret
   store, never sent back to the app, and works without the GitHub CLI.
2. `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` with `GH_HOST` for GitHub Enterprise Server) in the
   server's environment.
3. The GitHub CLI (version 2.81.0 or newer), signed in on the machine running T3 Code:
   ```bash
   brew install gh
   gh auth login
   ```

Then open **Settings → Source Control** and verify GitHub shows as authenticated. You can now
clone, publish, and create pull requests.

If `gh` is signed in to several accounts or hosts, expand **GitHub** in the same place to pick
the account each host uses or turn a host off. A saved token or `GH_TOKEN` takes precedence
over that choice; a host turned off stays off either way.

### For GitLab

1. Install the GitLab CLI:
   ```bash
   brew install glab
   ```
2. Authenticate:
   ```bash
   glab auth login
   ```
3. Check **Settings → Source Control** to confirm the connection

### For Bitbucket

Bitbucket uses tokens instead of a CLI tool. On web or desktop, open **Settings → Source Control**,
expand **Bitbucket**, and choose how to sign in:

- **Access token**: a token created for one repository, project, or workspace. It can only reach
  what it was created for.
- **API token**: an Atlassian API token for your account, used with your account email. It can
  reach every repository you can. Give it read/write access to repositories and pull requests, plus
  user read access (`read:user:bitbucket`, used to verify the connection).

Choose **Save**. The change applies right away and replaces any credential saved with the other
method. Credentials are saved on the environment's server, so select a remote environment to
configure it. Saved tokens can't be viewed again; enter a new one to replace it, or choose
**Remove**.

If no credentials are saved, T3 Code falls back to these environment variables on the machine
running T3 Code. Restart T3 Code after changing them:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
# or
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

If both kinds are set, the access token wins. Saved credentials always win over the variables.

### For Azure DevOps

1. Install Azure CLI:
   ```bash
   brew install azure-cli
   ```
2. Add the DevOps extension:
   ```bash
   az extension add --name azure-devops
   ```
3. Sign in:
   ```bash
   az login
   ```

---

## Requirements & Troubleshooting

**Git is required** – T3 Code uses Git for all local operations. Ensure `git` is installed on your server.

**Server-side setup** – Authentication happens on the machine running T3 Code (the server), not your local browser. If you're using a hosted or team instance, your administrator may have already configured providers.

**Common issues:**

- **Provider shows "Not authenticated"** – Run the login command for that provider (e.g., `gh auth login`) in a terminal on the server, then rescan in Settings
- **GitHub says it could not verify sign-in status** – T3 Code needs GitHub CLI 2.81.0 or newer to check sign-in status. Update `gh` (e.g., `brew upgrade gh`) and rescan, or save a token in **Settings → Source Control**
- **Bitbucket not connecting** – Check the credentials saved in **Settings → Source Control**. If you use environment variables instead, make sure they are set in the correct shell profile and the server was restarted
- **Can't push to a remote** – Verify your Git remote URL matches the provider you've authenticated with (SSH vs HTTPS remotes may need different credentials)

**Need more help?** Check your provider's CLI documentation:

- [GitHub CLI](https://cli.github.com/)
- [GitLab CLI](https://gitlab.com/gitlab-org/cli)
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/)

## Finding a thread by its linked pull request

On web and desktop, sidebar search and the command palette match the linked PR number
(such as **#287**), repository plus number, or URL. This searches links already attached to
threads; it does not query the source-control host.

Remote **Open in editor** also supports Zed over SSH when the environment advertises an
SSH target and Zed is installed on the client machine.

Enable **Proactive panels** in Settings → General to open linked pull requests and completed-run
changes automatically on desktop-sized layouts. Changes open only when a ready checkpoint contains
modified files. Closing a panel or choosing another surface takes precedence over pending automatic
opens. A linked PR already shown in the panel follows its replacement; unrelated reviews stay put.
Compact layouts and the native iOS app keep explicit navigation.

When right-panel tabs overflow, use the left and right arrows or the mouse wheel over the
tab strip to reach hidden tabs. Selecting a tab brings it into view. Arrow scrolling respects
your system's reduced-motion preference.

## Watching a pull request

Ask the agent to watch, monitor, or babysit a pull request and it calls `watch_pull_request`. While
the thread is active, the server checks the pull request every two minutes and wakes the agent when a
check fails, the checks pass, someone else comments or reviews, or the branch starts to conflict.
Threads in a project that watch the same pull request share one check. On GitHub, a check first
asks whether anything changed and reads the pull request only when it did; on other hosts, a pull
request with nothing in progress is checked again when something changes or every 10 minutes. This
keeps watching inside the host's rate limit. Comments from your own account do not wake it. Watching ends
when the pull request merges or closes, after 10 wakes in a row that bring only comments, or after 8
failed reads in a row. A rate limit only pauses watching. Pressing Stop on the thread, settling it,
or archiving it also ends all its watches. Unsettle the thread before starting a new watch. Subagents cannot watch pull
requests; the thread that delegated to them does. To start or stop it yourself, use the row menu in
the **Linked pull requests** panel; a watched pull request shows an eye icon there. On web and
desktop, the thread details card also shows an eye on a watched branch pull request; click it to
stop watching.

A watched thread counts as working between wakes, so it stays in the **Working** section and does
not auto-settle. Agents stop watching when they hand the work back to you, and the thread then
returns to your inbox. On web and desktop, the Stop shortcut ends a thread's watches when it has
nothing else running.

## Completing and reversing a review

To keep agent co-author and generated-by lines out of GitHub merge and squash messages, turn on
**Remove agent credits when merging** (see project settings).

When checks are still pending, the web review header offers auto-merge where your host supports it. Once armed, it shows the saved merge strategy. You can disable auto-merge or choose to merge immediately from the actions menu.

On GitHub, workflows waiting for a maintainer appear as awaiting approval. **Approve workflows to run** asks you to review the code and workflow changes before allowing them to start. A merged pull request offers **Revert changes**, which opens a new pull request to reverse its changes.

The native iOS review provides these actions too, including the saved auto-merge strategy. Both clients offer **Close with comment** and **Reopen with comment**. If the comment succeeds but the host refuses the state change, the comment stays posted and the error explains what failed.

Actions are available only when your host supports them and your account has permission.

## Source control on iPhone and iPad

Open a thread's **Details → Source Control** to commit, push, pull and publish. **Commit** asks for a
message and shows what will be included. While an action runs, its row shows the current step, such
as a running hook or the push. A failed commit, push or pull stays on screen with the host's reason;
a rejected push suggests pulling first. Publishing directly to the default branch asks you to
confirm first. When the branch has conflicts, commit actions hide and
**Ask Agent to Resolve** hands the conflict to the thread's agent. Tap a changed file to open it in
**Review**.

Pull-request links can open another repository on a Git host configured in the same environment, even when that repository has no local project. Web and native iOS keep the linked repository selected throughout review, comments, diffs and actions. Your existing checkout is used to contact the host.
