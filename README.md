# T3 Code (Bl4ckBl1zZ fork)

> [!NOTE]
> This is a personal fork of [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools. It follows
> upstream closely and publishes its own desktop and iOS builds, which connect through this fork's
> own T3 Connect relay. All credit for T3 Code goes to its upstream authors. For the official apps,
> the hosted web app, and support, go to [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

T3 Code is an "agent harness control surface". It enables control of the agents on your machine from a desktop, web, or mobile app.

<p align="center">
  <a href="https://github.com/Bl4ckBl1zZ/t3code/releases">
    <img src="./.github/readme/hero.webp" width="100%" alt="T3 Code on desktop with a finished Claude thread, next to the phone app asking to approve a command from Codex" />
  </a>
</p>

T3 Code runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from your phone.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, T3 Code can control it.

## What you get

- **Your subscriptions.** T3 Code does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads. This fork ships an iOS app through TestFlight.
- **Remote ready.** Run agents on any machine. Connect over your local network, Tailscale, or [T3 Connect](./docs/user/remote-access.md).
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Fast.** Performance is a feature here. We measure it, and we treat a dropped frame as a bug.
- **Open.** MIT licensed. If you don't like something, fork it.

## Install

### Desktop app

Download the latest `fork-v*` release from this fork's
[GitHub Releases](https://github.com/Bl4ckBl1zZ/t3code/releases):

- macOS (Apple Silicon): `T3-Code-<version>-arm64.dmg`
- Windows (x64 or ARM64): `T3-Code-<version>-<arch>.exe`. The installer is unsigned, so Windows
  SmartScreen warns on first run.

Installed builds update themselves from these releases.

The upstream install script, `npx t3`, and the winget, scoop, Homebrew, AUR, Nix, and `.deb`
packages all install official T3 Code, not this fork.

### Command line

This fork does not publish a standalone `t3` binary. The desktop app includes the `t3` command:
open **Settings → General → About** and choose **Install** next to **t3 command**. To run a server
without the desktop app, build it from source (see [Install T3 Code](./docs/user/install.md)).

### Mobile app

This fork's iOS app ships through TestFlight. There is no App Store or Android build of the fork;
the store apps are official T3 Code.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## Contributing

- Build from source with the [development runbook](./docs/operations/development.md#first-checkout). The [architecture overview](./docs/internals/overview.md) explains how it works.
- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

This fork does not take issues or feature requests. For T3 Code itself, use upstream's
[Ideas discussions](https://github.com/pingdotgg/t3code/discussions/categories/ideas) and
[Discord](https://discord.gg/jn4EGJjrvv).

## License

[MIT](./LICENSE)
