import { T3_PROJECT_FILE_NAME } from "@t3tools/contracts";

import { resolveProjectFileSchemaUrl } from "../project/projectFileSchemaUrl.ts";

export const T3_HTML_EMBED_INSTRUCTIONS = `
## Interactive HTML embeds in chat

The T3 Code chat UI renders any fenced code block with the language \`t3-html\` as a live, sandboxed HTML view instead of showing the code. It is how you *show* the user something instead of describing it: charts, diagrams, UI mockups, before/after comparisons, small interactive demos, styled tables, dashboards, animations.

### When to use it

Reach for an embed by default — without asking permission first — whenever:

- **The user asks what something looks like.** "How does it look", "show me", "what would that look like" — render it. A prose description of a layout is the wrong answer when you can draw it.
- **You changed UI.** After a visual change, follow the summary with an embed showing the resulting layout, so the user can react to a picture rather than to a diff.
- **You are proposing UI.** Mock up the options and put them side by side; the user picks by looking, not by reading paragraphs of description.
- **A visual change has a meaningful before.** Show before and after in one embed, labelled, side by side (stacked on narrow widths). Do this for redesigns, spacing/color/typography changes, and copy changes that alter layout.
- **You would otherwise emit a wall of numbers, a tree, a state machine, a timeline, a flow, or an architecture sketch** — chart or diagram it instead.
- **You are comparing several options across several dimensions** — a styled comparison table beats an ASCII one.

Skip it for code the user is meant to read (use a normal language fence), for plain prose answers, and for single facts. Do not embed a screenshot-style mock when you have access to the real running app and a real screenshot is what was asked for — an embed is your rendering of the UI, not evidence that the app behaves that way. Say which one you are giving them when it matters.

### How to write one

- Put a complete, self-contained snippet inside the fence: HTML plus optional \`<style>\` and \`<script>\` tags. Embedded CSS and JavaScript are fully supported and executed.
- The embed runs in a locked-down sandbox with no access to the app, the page around it, local files, or navigation; popups and link navigation are blocked. A Content-Security-Policy also blocks all network requests (fetch/XHR/external scripts, styles, images, fonts). Everything must be inline; embed images, fonts, and media as \`data:\` URIs and inline all data.
- The container spans the chat width on desktop and mobile and grows to your content's full height inline — it never scrolls or clips, so tall embeds simply push the rest of the message down; keep them as short as the idea allows. Design responsively: avoid fixed pixel widths, use %/flex/grid, and assume widths from ~320px (phones) to ~800px (desktop). The user can tap/click an expand button to open the embed in a large popup.
- The document defaults to the app's light/dark color scheme with a transparent background; style your own colors when contrast matters in both schemes.
- Emit several \`t3-html\` blocks in one message to stack multiple independent embeds below each other; each renders as its own container.
- Keep it tight: one idea per embed, no scaffolding the user did not ask for, and label anything ambiguous.

Before/after comparison — the default shape for a visual change:

\`\`\`t3-html
<style>
  .cmp{display:flex;flex-wrap:wrap;gap:12px}
  .pane{flex:1 1 240px;border:1px solid rgba(128,128,128,.35);border-radius:8px;padding:12px}
  .tag{font:600 11px system-ui;letter-spacing:.06em;opacity:.6;margin-bottom:8px}
  .bar{height:14px;background:#4f7cff;border-radius:4px;margin:4px 0}
</style>
<div class="cmp">
  <div class="pane"><div class="tag">BEFORE</div><div class="bar" style="width:80%"></div></div>
  <div class="pane"><div class="tag">AFTER</div><div class="bar" style="width:55%"></div></div>
</div>
\`\`\`
`;

/**
 * How to write `t3.json`, for agents asked to set a project up.
 *
 * Without this an agent works from whatever it learnt about T3 Code in
 * training: the upstream field set, and an upstream schema URL that this build
 * does not serve. The URL is resolved from this install rather than hardcoded,
 * so the document an agent fetches is the one this build actually validates
 * against. Points at the URL rather than listing every field inline, so the
 * instructions cannot drift out of date as the schema grows.
 */
export const buildProjectFileInstructions = (schemaUrl: string | null): string => `

## Project configuration (${T3_PROJECT_FILE_NAME})

\`${T3_PROJECT_FILE_NAME}\` at the repository root is T3 Code's checked-in project configuration, shared with everyone who opens the repo. It declares the project icon, the project's dev-server URL (\`previewUrl\`, always listed in the thread's Ports panel), and \`scripts\` the team can run from the app.
${
  schemaUrl === null
    ? ""
    : `- Start a new file with \`{ "$schema": "${schemaUrl}" }\`, and read that URL for the authoritative field list. It is generated from the running build, so it is the only correct source.
`
}- The schema rejects unknown properties: do not invent fields, and do not trust field names you remember from another version of T3 Code.
- Preserve fields you did not come to change. T3 Code rewrites \`scripts\` whenever the user edits actions in the app, and leaves everything else in place.
- Edits land without a restart: the file and the app's actions reconcile in both directions within a couple of seconds.`;

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

## T3 Code orchestration

The \`t3-code\` MCP server provides app-owned orchestration. Treat these concepts distinctly:

- A delegated task/subagent is child work owned by the current thread. When the user asks for an agent, subagent, worker, delegation, or parallel help, use \`delegate_task\` once per child task. This remains true when targeting a different provider. Use \`orchestrator_capabilities\` to discover provider/model IDs, retain each returned \`taskId\`, and use \`task_status\` or \`task_cancel\` to manage it. The returned \`childThreadId\` is backing storage for the subagent; do not replace delegation with ordinary thread creation.
- \`create_threads\` and \`t3_thread_start\` create ordinary top-level T3 conversations. Use them only when the user explicitly asks for separate/new/top-level threads or conversations. Never use them merely because the user said "subagent" or requested parallel delegated work.
- \`schedule_task\` creates persistent recurring work in the app scheduler. Pass \`schedule\` as a structured object, never as JSON text: \`{"type":"interval","everyMs":3600000}\` for an interval, or \`{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}\` for a wall-clock schedule. By default runs return to the current thread; set \`bindToCurrentThread=false\` only when the user wants a fresh thread for every run. After scheduling, report the returned cadence and next run time.

Tool names may include an MCP prefix (for example \`mcp__t3-code__delegate_task\`); the semantics are the same. Keep polling/wait loops bounded, do not duplicate active work, and use stable \`clientRequestId\` values when retrying mutations.
${buildProjectFileInstructions(resolveProjectFileSchemaUrl())}
${T3_HTML_EMBED_INSTRUCTIONS}`;

/**
 * Providers without a system/developer-instruction channel receive this
 * context in the first prompt. Keep the wrapper explicit so it cannot be
 * mistaken for text authored by the user.
 */
export function prependT3OrchestrationInstructions(prompt: string): string {
  return `<t3_code_orchestration_instructions>${T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function t3OrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasT3Mcp: boolean;
}): string {
  return input.runOrdinal === 1 && input.hasT3Mcp
    ? prependT3OrchestrationInstructions(input.prompt)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(hasT3Mcp: boolean): string | undefined {
  return hasT3Mcp ? T3_CODE_ORCHESTRATION_INSTRUCTIONS : undefined;
}
