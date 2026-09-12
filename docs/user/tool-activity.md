# Tool activity

While an agent works, the current operation appears in a compact row. Open it to
inspect the individual calls in a scrollable history. Background commands remain
visible separately while they are running.

Completed groups of successful calls appear as a summary, such as “Ran 3 commands
and changed 2 files.” Open the summary to inspect the calls. Repeated edits to the
same path count as one changed file. Failures, active work and persistent result
cards remain separately visible. The native iOS app uses the same grouping.

Your expansion choices stay in place as you browse the conversation or close and reopen a
tool group. Web and desktop restore the position within a long tool result. Native iOS
restores the position within the tool row you were reading. These choices last for the current conversation
view and do not change the **Always expand activity** preference.

New calls follow the end of web tool history only when you were already reading at the
bottom. Updates to an existing call do not pull you away from older output.

Known T3 tools use readable action names and reflect whether the call is running, completed,
failed or canceled. Pull-request actions show the request number when available and use a
pull-request icon; preview-browser actions use a browser icon. Completed history summaries
keep those actions distinct from other tools.

When a supported provider identifies the browser or app behind a tool call, activity shows
its icon when available. Grouped history names the apps used, such as “Used Chrome
integration,” while pull-request actions stay separately identified. App icons come from
the connected Mac; an unavailable icon falls back to the browser or computer symbol.
