import { T3_PROJECT_FILE_NAME } from "@t3tools/contracts";

import { resolveProjectFileSchemaUrl } from "../project/projectFileSchemaUrl.ts";

import {
  T3_CHAT_PRESENTATION_INSTRUCTIONS,
  T3_HTML_EMBED_INSTRUCTIONS,
} from "./T3ChatPresentationInstructions.ts";

export { T3_HTML_EMBED_INSTRUCTIONS } from "./T3ChatPresentationInstructions.ts";

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
- \`schedule_task\` creates persistent recurring work in the app scheduler. Pass \`schedule\` as a structured object, never as JSON text: \`{"type":"interval","everyMs":3600000}\` for an interval, or \`{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}\` for a wall-clock schedule. By default runs return to the current thread; set \`bindToCurrentThread=false\` only when the user wants a fresh thread for every run. After scheduling, report the returned cadence and next run time. Use this tool for requests such as "do this every hour" in T3, including Hermes threads. Provider-native cron jobs run outside this conversation and do not deliver messages back here; use those only when the user explicitly requests an independent native job.

Tool names may include an MCP prefix (for example \`mcp__t3-code__delegate_task\`); the semantics are the same. Keep polling/wait loops bounded, do not duplicate active work, and use stable \`clientRequestId\` values when retrying mutations.
${buildProjectFileInstructions(resolveProjectFileSchemaUrl())}
${T3_CHAT_PRESENTATION_INSTRUCTIONS}
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

/** Hermes needs presentation guidance even without MCP and after importing older conversations. */
export function t3OrchestrationPromptForHermesTurn(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasT3Mcp: boolean;
}): string {
  if (input.hasT3Mcp && input.runOrdinal === 1) {
    return prependT3OrchestrationInstructions(input.prompt);
  }
  const instructions = [
    T3_CHAT_PRESENTATION_INSTRUCTIONS.trim(),
    input.runOrdinal === 1 ? T3_HTML_EMBED_INSTRUCTIONS.trim() : "",
    input.hasT3Mcp
      ? "For recurring work in this T3 conversation, use the t3-code MCP schedule_task tool with bindToCurrentThread=true. Native Hermes cron runs separately and does not deliver messages into this thread; use it only when explicitly requested. Report the tool's returned schedule and next run time before claiming scheduling succeeded."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return `<t3_chat_instructions>${instructions}</t3_chat_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}
