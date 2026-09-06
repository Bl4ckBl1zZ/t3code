# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

## Subscription limits on iPhone and iPad

In **Settings → Usage**, choose **Limits** to see Codex and Claude subscription windows,
percent used, reset times, and when each report was checked. Choose which environments to
include, then use **Refresh limits** to request fresh reports.

The same known account on multiple environments appears once, using its freshest report.
Accounts without a reported identity stay separate. Pooled bars weight each reporting account
equally; they do not claim that different subscription plans have equal token allowances.
Unavailable environments, unsupported accounts, failed probes, and stale reports are labeled.
This view does not redeem reset credits or read accounts from external proxy hubs.
