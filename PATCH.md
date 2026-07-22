# Fork changes

This fork diverged from `pingdotgg/t3code` at `92be60e7` and adds the following technical changes:

- Models work as organization → project → workspace → sub-chat, with tab groups, workbench tabs, workspace file browsing/editing, persistent terminal state, and per-project configuration.
- Adds a bundled Chrome extension and backend browser-agent runtime with thread/sub-agent isolation, host-local auto-connect, side-panel control, annotations, screenshots, and remote browser support.
- Extends orchestration with queued/steered turns, baseline checkpoints, projection hardening, organization-panel agents, Codex skill/slash-command discovery, and richer tool activity.
- Expands source-control UX with fork-aware remotes, base-branch synchronization, PR checks/comments/merge controls, draft-to-ready actions, and agent-routed Git operations.
- Adds OpenRouter/fallback audio transcription, sandboxed HTML previews, project favicons, sidebar folders, workspace scripts, and synchronized client settings.
- Ships only the Apple-silicon desktop app from GitHub Actions. Pushes to `main` create a downloadable workflow artifact; `v*` tags also publish the DMG/ZIP to GitHub Releases. Packaged builds explicitly use `Bl4ckBl1zZ/t3code` for update checks. Signing and notarization are enabled when the Apple secrets documented below are configured.

## Fork operations

- Git remotes: `origin` is `Bl4ckBl1zZ/t3code`; `upstream` is `pingdotgg/t3code`.
- The hourly Codex automation fetches both remotes and merges `upstream/main` into `origin/main` only when the merge is clean. Conflicts are reported without force-pushing or discarding fork commits.
- Optional signed builds require `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` as repository secrets. Without them, CI still produces an unsigned downloadable build.
