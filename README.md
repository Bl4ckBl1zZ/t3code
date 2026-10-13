# T3 Code (Bl4ckBl1zZ fork)

> [!NOTE]
> This is a personal fork of [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools. It follows
> upstream closely and publishes its own desktop and iOS builds, which connect through this fork's
> own T3 Connect relay. All credit for T3 Code goes to its upstream authors. For the official apps,
> the hosted web app, and support, go to [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

T3 Code is an "agent harness control surface". It enables control of the agents on your machine from a desktop, web, or mobile app.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Desktop app

Download the latest `fork-v*` release from this fork's
[GitHub Releases](https://github.com/Bl4ckBl1zZ/t3code/releases):

- macOS (Apple Silicon): `T3-Code-<version>-arm64.dmg`
- Windows (x64 or ARM64): `T3-Code-<version>-<arch>.exe`. The installer is unsigned, so Windows
  SmartScreen warns on first run.

Installed builds update themselves from these releases.

The upstream install script, `npx t3`, and the winget, scoop, Homebrew, AUR, and `.deb` packages
all install official T3 Code, not this fork.

### Command line

This fork does not publish a standalone `t3` binary. The desktop app includes the `t3` command:
open **Settings → General → About** and choose **Install** next to **t3 command**. To run a server
without the desktop app, build it from source (see [Install T3 Code](./docs/user/install.md)).

### Mobile app

This fork's iOS app ships through TestFlight. There is no App Store or Android build of the fork;
the store apps are official T3 Code.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

This fork does not take issues or feature requests. For T3 Code itself, use upstream's
[Ideas discussions](https://github.com/pingdotgg/t3code/discussions/categories/ideas) and
[Discord](https://discord.gg/jn4EGJjrvv).
