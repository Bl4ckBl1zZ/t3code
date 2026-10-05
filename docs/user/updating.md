# Keeping T3 Code in Sync

The T3 Code web or desktop app and the server it connects to work best when they use the same
version. If they do not match, T3 Code shows a warning with the right update option for that server.

## Where to Find the Update

You may see the warning in either of these places:

- above the message box in the current conversation
- **Settings** → **Connections**, beside the affected connection

Dismissing the conversation warning only hides that reminder for those two versions. It does not
update the server, and the version difference remains visible in Connections.

## Before You Update

Updating restarts the server, so the connection disappears briefly. **Settings → General → Continue
threads after restarts** is off by default. Edits apply to connected machines that support the setting. When enabled, interrupted threads resume after an update,
crash or machine restart once T3 starts again. This setting does not start T3 automatically.

Recovery requires a saved provider session. Codex continues without a synthetic prompt; other
providers receive a short instruction to continue after checking the current state. Completed,
archived, explicitly settled and superseded work stays stopped. If the saved session cannot resume,
the thread reports the failure and waits for a new message. Terminal commands may still be
interrupted.

The update does not remove saved threads, settings, or project files.

## Choose the Action You See

| Action                     | What to do                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Available for the T3 Code Linux background service and recent desktop-managed servers. Select the button and leave T3 Code open while it prepares, tests, restarts, and reconnects. |
| **Update the desktop app** | Recent desktop apps accept remote updates. Older apps must be updated on the machine that runs them.                                                                                |
| **Copy update command**    | Run the command on the server machine to update the detected global npm install, then restart the server with your usual options.                                                   |
| **Copy relaunch command**  | Stop the current T3 Code server on its machine and relaunch it with the copied command and your usual subcommand and options. This does not update an installed `t3` command.       |

The available action depends on how that server was started. T3 Code does not update connected
servers silently in the background.

An older background-service launcher may ask you to run the exact
`npx t3@<version> service update` command on the server machine. That one local update installs the
rollback support needed for later remote updates, including versions that change the database.

After selecting **Update**, the notice becomes a live status line: **Downloading…** while the new
version is fetched and verified, then **Restarting…** while the server restarts into it. The same
status appears in the conversation and in Connections, so navigating between them does not lose the
update. A failure remains visible with its error and an option to retry.

**Copy relaunch command** gives you `npx t3@<client-version>` (or `pnpm dlx` / `bunx` when the
server was started that way), which relaunches the server directly at the matching version. Add
whatever startup options you normally use. **Copy update command** appears instead when the server
runs from a global npm install, and updates that install in place.

If the server instead runs as the T3 Code background service, update the service on the host and
pin the same version:

```sh
npx t3@<client-version> service update
```

`service update` installs the version of the CLI that invoked it, so `npx t3@latest service update`
only resolves the skew when your client happens to be on the latest release. The exact version from
the warning always works.

See [Running T3 Code in the Background](./background-service.md) for install, status, and removal
commands.

### A server too old to connect

When a server speaks an older conversation protocol than this client, T3 Code cannot open a
session with it, so it appears switched off in **Settings → Connections** with the reason. If that
server can update itself, the row offers **Update** anyway: T3 Code reaches the server only to run
the update, waits for it to come back on a compatible version, and then switches it back on and
connects. This works for a machine you just paired and for one T3 Connect reports as outdated. A
server that cannot update itself is not saved when you pair it; update it on its own machine first.

## After the Update

Keep the web or desktop app open while the server restarts. The update completes only after the
service launcher reports that exact update committed and the replacement server is ready to accept
commands. A rollback is reported immediately instead of waiting for a generic reconnect timeout.

If a step fails:

1. Retry the offered action once.
2. Make sure you updated the machine named in the warning, not only the device you are using.
3. For a command-line server, relaunch it with `npx t3@<client-version>`, replacing
   `<client-version>` with the client version shown in the warning.

## Update providers

**Settings → Providers** shows provider updates for the selected environment, one account at a
time. On web and desktop, **Update all** in the section header updates every outdated provider on
every connected environment at once, then reports the results in one notice that lists each update
that failed. Hover it to see which providers it will update on each environment. Providers that only
offer a manual update command, or whose accounts on one environment need different update
commands, are not included; update those from their account in **Settings → Providers**.
Environments you can view but not operate report a failure instead of updating.

## The Mobile App

The native iOS app receives its own updates through TestFlight or the App Store.
To update a connected Mac’s desktop app from your phone, open **Settings → Connections → Desktop
updates**, select the environment, then choose **Check and update**. Confirm the relaunch and keep
the screen open while the app downloads, restarts, and reconnects. Completion means the server has
returned on the version the desktop app actually downloaded from its update channel.

The desktop app briefly disconnects all clients on that machine. Enable **Continue after restarts**
in Thread organization to resume eligible running threads after the update. With that preference off,
active agent work may be interrupted.
A failed installer leaves a readable error and the app attempts to restore its backend connections.
Older desktop apps display instructions for updating on the host instead.

For remote connection setup and access troubleshooting, see [Remote Access](./remote-access.md).
