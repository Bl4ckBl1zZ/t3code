# Provider accounts

Open Settings → Providers and select an environment to see its accounts. Select an
account in the list to edit its settings and models. The account's enabled switch
remains in the list, so you can compare availability without opening every editor.
Use Add provider to create an account on the selected environment. Health-check
intervals are under Advanced. Sessions with limited permissions can browse accounts
but cannot change their settings or update provider software.

On iOS, open Settings → Agents, select an environment, then open an account to
choose its visible models. Enable all and Disable all affect that account's
built-in models. Claude's auto-compaction setting applies to the selected environment.

Custom models can have a display name and their own composer options. On web,
add a model ID in the account's model list and use Edit to customize it. On iOS,
open the account's Custom models screen. Both editors let you copy options from
an available model, start with a provider preset, or define choice and toggle
controls. Select one default per choice control. Save applies the whole edit;
Cancel leaves the saved model unchanged.

The model ID must exist at your provider. Renaming its display label does not
change which model runs. Custom options replace that model's default option set;
only option IDs supported by the provider affect requests. Servers that predate
custom model definitions need an update before these editors can save them.

When an account is unavailable, the model picker and status banner can open
its setup screen on the correct environment. Codex and Claude setup include an
account-specific terminal with an install or sign-in command ready to review.
Press Enter to run it, then refresh status. Closing the setup terminal ends that
terminal session. Your configured account home and binary are respected.

On iOS, use **Set up agents** in the model picker, or **Install or sign in** in
an account's settings. Setup stays on the selected task's machine. Older servers
show that an update is required instead of opening an unscoped terminal.

Model lists can refresh between app releases. New models may carry a **New** label,
and models that require a newer agent version appear after that agent is updated.
If a refresh fails, the previous catalog stays available. Custom model names remain
specific to their account.

For Claude, **Context** controls when conversation compaction happens. The model keeps
its largest supported window; selecting 250K, 500K, or 750K sets an earlier compaction
threshold, while 1M leaves the model's own limit in control. An account-level compaction
limit can set a lower ceiling.
