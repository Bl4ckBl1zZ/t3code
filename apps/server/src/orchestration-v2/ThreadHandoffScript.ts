import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";

const HANDOFF_SCRIPT_TRANSCRIPT_MAX_CHARS = 60_000;
const FALLBACK_TRANSCRIPT_MAX_CHARS = 16_000;

/**
 * Newest-first conversation digest for the handoff summary prompt: keep whole
 * user/assistant sections while they fit the char budget and mark truncation
 * once older content stops fitting.
 */
export function makeThreadHandoffTranscript(
  messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "role" | "text" | "streaming">>,
  maxChars: number = HANDOFF_SCRIPT_TRANSCRIPT_MAX_CHARS,
): string {
  const sections = messages.flatMap((message) => {
    if (message.role === "system" || message.streaming) {
      return [];
    }
    const text = message.text.trim();
    if (text.length === 0) {
      return [];
    }
    return [`${message.role === "user" ? "User" : "Assistant"}:\n${text}`];
  });
  const selected: Array<string> = [];
  let used = 0;
  for (const section of sections.toReversed()) {
    if (used + section.length + 2 > maxChars) {
      selected.unshift("[Earlier content truncated]");
      break;
    }
    selected.unshift(section);
    used += section.length + 2;
  }
  return selected.join("\n\n");
}

export interface ThreadHandoffScriptContext {
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly workspaceRoot: string | null;
  readonly providerInstanceId: string;
  /** AI summary when available, otherwise null to fall back to the transcript digest. */
  readonly summary: string | null;
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "role" | "text" | "streaming">
  >;
}

/** Prompt-ready handoff document for continuing the thread in another agent session. */
export function makeThreadHandoffScript(context: ThreadHandoffScriptContext): string {
  const workspacePath = context.worktreePath ?? context.workspaceRoot;
  const metadata = [
    `- Thread: ${context.title}`,
    ...(context.branch === null ? [] : [`- Branch: ${context.branch}`]),
    ...(workspacePath === null ? [] : [`- Workspace: ${workspacePath}`]),
    `- Original agent: ${context.providerInstanceId}`,
  ];
  const contextSection =
    context.summary !== null
      ? ["## Context summary", "", context.summary]
      : [
          "## Conversation transcript (digest)",
          "",
          makeThreadHandoffTranscript(context.messages, FALLBACK_TRANSCRIPT_MAX_CHARS) ||
            "No conversation content yet.",
        ];
  return [
    "# Thread handoff",
    "",
    "You are taking over an in-progress coding conversation from another agent session.",
    "Use the context below to continue the work without asking the user to repeat themselves.",
    "",
    ...metadata,
    "",
    ...contextSection,
    "",
    "## Instructions",
    "",
    "Continue this work in the workspace listed above. Verify the current state of the",
    "code before assuming any described change is still pending.",
    "",
  ].join("\n");
}
