/**
 * Slash commands a T3 Work conversation handles locally instead of sending to
 * Hermes. Mirrors the web composer: `/new` and `/reset` start a fresh-context
 * conversation, `/clear` wipes the visible timeline.
 *
 * Only the bare command is intercepted — `/new plan the week` is a real
 * message, and swallowing the trailing text would silently discard it.
 */
export function isHermesFreshChatCommand(input: {
  readonly text: string;
  readonly isHermesConversation: boolean;
}): boolean {
  if (!input.isHermesConversation) return false;
  return /^\/(?:new|reset)$/iu.test(input.text.trim());
}

export function isHermesClearChatCommand(input: {
  readonly text: string;
  readonly isHermesConversation: boolean;
}): boolean {
  if (!input.isHermesConversation) return false;
  return /^\/clear$/iu.test(input.text.trim());
}

export type HermesChatCommand = "fresh-chat" | "clear-timeline" | null;

/** Single entry point for the composer: which local command, if any, this text is. */
export function resolveHermesChatCommand(input: {
  readonly text: string;
  readonly isHermesConversation: boolean;
}): HermesChatCommand {
  if (isHermesFreshChatCommand(input)) return "fresh-chat";
  if (isHermesClearChatCommand(input)) return "clear-timeline";
  return null;
}
