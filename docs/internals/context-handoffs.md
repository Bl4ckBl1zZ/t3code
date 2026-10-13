# Context handoffs

Portable provider and fork handoffs are textual summaries. They do not claim native provider context
parity.

`ContextHandoffServiceV2` includes user messages, assistant messages, command executions, file
changes, checkpoints, and prior handoffs. It skips other turn item types. For text-bearing items,
`compactText` replaces every whitespace run with one space, trims the result, and returns at most
240 characters. A truncated value contains the first 237 characters followed by `...`. File changes
carry the filename, while checkpoints carry only the number of files.

Provider handoffs use either the full eligible app history or the delta since that provider last
participated, carried as intact historical messages chosen within a byte budget
(`packages/provider-core/src/server/handoffBudget.ts`). Fork merge-back handoffs summarize eligible
delta items from the child. Neither path reconstructs provider-native session state, tool state, or
approvals.

When delivery has to omit history, `deliverContextHandoffs` reserves up to a quarter of the budget
(at most 8,000 bytes) and asks `ContextHandoffSummary` for an AI summary of exactly the omitted
items. The reserve is taken before the final selection, so the summary never displaces the items it
was written around. Generation runs in the effect worker as the target turn starts, uses the
project's text generation model, and is best effort: a failure or timeout delivers the selection
without a summary. The summary is stored on `history.summary` so a retried delivery reuses it, and
like the rest of `history` it stays off the wire.

Legacy v1 continuation uses a separate algorithm. It considers only user and assistant messages,
walks backward from the newest message, and builds a transcript suffix within a 32,000-character
budget. Do not describe that migration budget as the limit for portable handoffs, and do not describe
the 240-character prefix as a migration rule.
