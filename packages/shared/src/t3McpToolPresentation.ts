import { parseChangeRequestUrl } from "./changeRequestUrl.ts";

export type T3McpToolLogo = "t3-code" | "pull-request" | "browser";

export interface T3McpToolPresentation {
  readonly displayName: string;
  readonly logo: T3McpToolLogo;
  readonly action?: "link-pr" | "unlink-pr" | "list-prs";
}

const T3_MCP_SERVER_ALIASES = new Set(["t3-code", "t3_code", "t3code"]);

const T3_MCP_TOOL_LABELS: Record<string, readonly [string, string, string, string]> = {
  link_pull_request: ["Link", "Linking", "Linked", "a pull request"],
  unlink_pull_request: ["Unlink", "Unlinking", "Unlinked", "a pull request"],
  list_thread_pull_requests: ["Check", "Checking", "Checked", "linked pull requests"],
  orchestrator_capabilities: ["Get", "Getting", "Got", "orchestration capabilities"],
  delegate_task: ["Delegate", "Delegating", "Delegated", "a child task"],
  task_status: ["Get", "Getting", "Got", "delegated task status"],
  task_cancel: ["Cancel", "Canceling", "Canceled", "delegated task"],
  schedule_task: ["Schedule", "Scheduling", "Scheduled", "a recurring task"],
  list_scheduled_tasks: ["List", "Listing", "Listed", "scheduled tasks"],
  update_scheduled_task: ["Update", "Updating", "Updated", "a scheduled task"],
  delete_scheduled_task: ["Delete", "Deleting", "Deleted", "a scheduled task"],
  create_threads: ["Create", "Creating", "Created", "T3 threads"],
  t3_thread_start: ["Start", "Starting", "Started", "a T3 thread"],
  t3_thread_list: ["List", "Listing", "Listed", "T3 threads"],
  t3_thread_read: ["Read", "Reading", "Read", "a T3 thread"],
  t3_thread_send: ["Send", "Sending", "Sent", "to a T3 thread"],
  t3_thread_wait: ["Wait", "Waiting", "Waited", "for a T3 thread"],
  t3_thread_interrupt: ["Interrupt", "Interrupting", "Interrupted", "a T3 thread"],
  t3_worktree_handoff: ["Hand off", "Handing off", "Handed off", "thread to a git worktree"],
  t3_worktree_status: ["Get", "Getting", "Got", "thread worktree status"],
  preview_status: ["Get", "Getting", "Got", "preview browser status"],
  preview_open: ["Open", "Opening", "Opened", "a page in the preview browser"],
  preview_navigate: ["Navigate", "Navigating", "Navigated", "the preview browser"],
  preview_snapshot: [
    "Take a snapshot of",
    "Taking a snapshot of",
    "Took a snapshot of",
    "the preview page",
  ],
  preview_click: ["Click", "Clicking", "Clicked", "in the preview browser"],
  preview_press: ["Press", "Pressing", "Pressed", "a key in the preview browser"],
  preview_type: ["Type", "Typing", "Typed", "in the preview browser"],
  preview_scroll: ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
  preview_resize: ["Resize", "Resizing", "Resized", "the preview browser"],
  preview_evaluate: ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
  preview_wait_for: ["Wait", "Waiting", "Waited", "for the preview page"],
  preview_set_appearance: ["Set", "Setting", "Set", "preview browser appearance"],
  preview_recording_start: ["Start", "Starting", "Started", "recording the preview browser"],
  preview_recording_stop: ["Stop", "Stopping", "Stopped", "recording the preview browser"],
};
const T3_MCP_TOOL_DISPLAY_NAMES = Object.fromEntries(
  Object.entries(T3_MCP_TOOL_LABELS).map(([name, [action, , , detail]]) => [
    name,
    `${action} ${detail}`,
  ]),
);

function normalizeT3McpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function resolveT3McpToolName(value: string): string | null {
  const label = normalizeT3McpToolLabel(value);
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      T3_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? tool
      : null;
  }

  const namespaceMatch = /^(?<server>t3-code|t3_code|t3code)(?:[.:/]|\s*·\s*)(?<tool>.+)$/i.exec(
    label,
  );
  if (namespaceMatch?.groups) {
    return namespaceMatch.groups.tool ?? null;
  }

  return Object.hasOwn(T3_MCP_TOOL_DISPLAY_NAMES, label) ? label : null;
}

export function resolveT3McpToolPresentation(
  toolName: string | null | undefined,
  status?: string,
  input?: unknown,
): T3McpToolPresentation | null {
  const resolvedToolName =
    toolName === undefined || toolName === null ? null : resolveT3McpToolName(toolName);
  if (resolvedToolName === null) {
    return null;
  }
  const labels = T3_MCP_TOOL_LABELS[resolvedToolName];
  if (!labels) return null;
  const [action, running, completed, detail] = labels;
  const verb =
    status === "running" || status === "waiting" || status === "pending" || status === "inProgress"
      ? running
      : status === "completed"
        ? completed
        : status === "failed"
          ? `Failed to ${action.toLowerCase()}`
          : status === "declined"
            ? `Declined to ${action.toLowerCase()}`
            : status === "stopped" || status === "cancelled" || status === "interrupted"
              ? `Stopped ${running.toLowerCase()}`
              : action;
  const prAction =
    resolvedToolName === "link_pull_request"
      ? "link-pr"
      : resolvedToolName === "unlink_pull_request"
        ? "unlink-pr"
        : resolvedToolName === "list_thread_pull_requests"
          ? "list-prs"
          : undefined;
  const args =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const urlNumber =
    typeof args?.url === "string" ? parseChangeRequestUrl(args.url)?.number : undefined;
  const number = urlNumber ?? args?.number;
  const target =
    prAction &&
    prAction !== "list-prs" &&
    typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number > 0
      ? `PR #${number}`
      : detail;
  return {
    displayName: `${verb} ${target}`,
    logo: prAction
      ? "pull-request"
      : resolvedToolName.startsWith("preview_")
        ? "browser"
        : "t3-code",
    ...(prAction ? { action: prAction } : {}),
  };
}
