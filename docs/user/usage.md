# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans selected environments. The environment filter shows scan progress and
explains unavailable or incompatible servers; totals appear as machines answer. Your selected
usage view, metric and time range are remembered.

## Subscription limits

Open **Limits** from Usage (or **Settings → Usage limits** on iPhone and iPad) to see Codex and Claude subscription windows,
quota remaining, reset times, and when each report was checked. Choose which environments to
include, then use **Refresh limits** to request fresh reports.

The same known account on multiple environments appears once, using its freshest report.
Accounts without a reported identity stay separate. Pooled bars weight each reporting account
equally; they do not claim that different subscription plans have equal token allowances.
Unavailable environments, unsupported accounts, failed probes, and stale reports are labeled.
CLIProxyAPI hubs can report additional accounts alongside local providers.

## Native iOS account comparison

**Settings → Usage limits** compares accounts from the same provider in aligned columns.
Each row represents the same quota window; a missing report is shown as **Not reported**.
Account names appear in the comparison and task list without displaying email addresses.

In **Settings → Agents**, toggle individual models or enable/disable all built-in models for
an account. These choices are saved to that environment and control its model picker.

## Custom model prices

Open **Model prices** from Usage to override an exact model ID’s rates in USD per
million tokens. These rates recalculate past and future usage, including estimates
that previously used provider-reported costs. Blank cache rates use the input rate;
enter `0` for free tokens. Reset a model to return to automatic pricing.

Web and desktop can apply edits to several environments. Mixed cells keep each
environment’s existing rate until you change them. If some saves fail, retry applies
only to those environments. On iPhone and iPad, choose an environment before editing
its model prices. A connected server with pricing support and write access is required.

Refreshing Usage first checks for updated model prices, so newly listed models can be priced
without waiting for the daily update. Closely repeated requests reuse the latest table. If the
price source is unavailable, cached prices still work. On iPhone and iPad, pull to refresh.
Native history also supports **Past 24h**, environment selection, and the full model breakdown.

## Codex reset credits

When Codex reports banked reset credits, Limits shows their count and next expiry. Choose
**Use reset** (or **Use reset credit** on iPhone and iPad), then confirm **Use credit** to redeem
one. This spends a banked credit and cannot be undone. The action requires permission to operate
the selected environment. A failed attempt can be retried with the same attempt ID. If redemption
succeeds but its follow-up report fails, refresh the limits to confirm their current state.

## Quota hubs

On web and desktop, open **Usage → Limits** and choose **Add hub** under an environment.
On iPhone or iPad, open **Settings → Usage → Limits → Quota hubs**, select an environment,
and add its hub URL and management key. The key stays in that server’s secret store.

Edit a hub to change its address, label, or key. Leaving the key blank while editing on iOS
or web keeps the existing key. Disable pauses its reports; Enable resumes them. Remove deletes
its configuration and stored key. Changes affect only the selected environment.

Hub accounts contribute to the same account comparisons and pooled bars. A known account
also configured locally is counted once, using its freshest report. Failed hubs show an error;
refresh to try again. Hub accounts report quota but cannot run tasks. Eligible Codex hub
accounts also support **Use reset**, with confirmation before spending a credit.
