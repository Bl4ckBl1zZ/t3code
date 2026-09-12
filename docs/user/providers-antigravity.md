# Antigravity

Add an Antigravity account in **Settings → Providers** on web or **Settings → Agents** on iOS. Choose the server that will run it,
then enable the account. Open **Install and sign in** to install the managed runtime and
sign in with Google. Installation and sign-in happen on the selected server, including
when you connect remotely from a phone. The native iOS app and web app offer the same
setup actions.

Choose a personal Google account, a business Google account, a Gemini API key, or Agent
Platform in the account editor. Save changes before starting setup. Business accounts
require a Google Cloud project and location; the editor names any missing configuration.
API keys remain sensitive account settings.

Google sign-in opens only when you choose **Open Google sign-in**. When signing in to a
remote server, Google may redirect your browser to a local address that cannot load.
Copy that complete callback address and paste it into the setup screen to finish the
same sign-in. You can cancel or retry without replacing another device's sign-in flow.

The model picker shows the models returned by your account. **Refresh** in Agents
refreshes that catalog. Workspace commands and skills follow the selected project or
worktree. Native questions require one of the offered choices; permission prompts show
any warning attached to a persistent approval.

Sign out from the account's setup screen or send `/logout` in an Antigravity thread.
Signing out stops that account's active sessions. Other provider accounts remain separate.
Removing the managed runtime requires its sessions to be stopped; it does not delete your
account profile or an executable you supplied yourself.

Antigravity reports subagent launches as a batch. The timeline keeps that batch active
until its parent turn ends, without inventing individual agent conversations or results.
Commands that continue after the response remain visible until they finish.
