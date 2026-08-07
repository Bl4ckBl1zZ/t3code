/**
 * Extraction of workflow observability signals from Claude SDK task messages.
 *
 * These fields are not in the SDK's declared message types -- they arrive as
 * extra properties on task_started/task_progress/task_notification, the same
 * way `task_type` does. So everything here is read reflectively and validated
 * before use; a malformed or absent field yields undefined rather than a
 * throw, because a missing progress annotation must never break ingestion of
 * the lifecycle event carrying it.
 *
 * Key names are accepted in both snake_case and camelCase. The SDK's task
 * payloads are not schema-stable across versions, and accepting both spellings
 * costs one array entry per field while a wrong guess silently produces an
 * Agents surface with no data and no error.
 *
 * @module ClaudeWorkflowSignals
 */
import {
  type OrchestrationV2RunHandles,
  type OrchestrationV2TaskUsage,
  type OrchestrationV2WorkflowPhase,
  type OrchestrationV2WorkflowProgress,
  sanitizeV2SessionUrl,
} from "@t3tools/contracts";

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readAny(source: Record<string, unknown>, keys: ReadonlyArray<string>): unknown {
  for (const key of keys) {
    const value = Reflect.get(source, key);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function readString(
  source: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined {
  const value = readAny(source, keys);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Non-negative integers only. A negative or fractional token count is a
 * malformed report, and passing it through would fail schema encoding later
 * at a point far from the cause.
 */
function readCount(
  source: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | undefined {
  const value = readAny(source, keys);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

export function claudeTaskUsageFromMessage(message: unknown): OrchestrationV2TaskUsage | undefined {
  const record = readRecord(message);
  if (record === undefined) return undefined;
  const usage = readRecord(readAny(record, ["usage", "task_usage", "taskUsage"]));
  if (usage === undefined) return undefined;

  const totalTokens = readCount(usage, ["total_tokens", "totalTokens"]);
  const inputTokens = readCount(usage, ["input_tokens", "inputTokens"]);
  const outputTokens = readCount(usage, ["output_tokens", "outputTokens"]);
  const cachedInputTokens = readCount(usage, [
    "cache_read_input_tokens",
    "cached_input_tokens",
    "cachedInputTokens",
  ]);
  const reasoningOutputTokens = readCount(usage, [
    "reasoning_output_tokens",
    "reasoningOutputTokens",
  ]);
  const toolUses = readCount(usage, ["tool_uses", "toolUses"]);
  const durationMs = readCount(usage, ["duration_ms", "durationMs"]);

  // Claude does not always send a total; derive it from the parts rather than
  // dropping an otherwise usable rollup. Only give up when nothing is present.
  const resolvedTotal =
    totalTokens ??
    (inputTokens === undefined && outputTokens === undefined
      ? undefined
      : (inputTokens ?? 0) + (outputTokens ?? 0));
  if (resolvedTotal === undefined) return undefined;

  return {
    totalTokens: resolvedTotal,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
    ...(toolUses === undefined ? {} : { toolUses }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function readPhases(value: unknown): ReadonlyArray<OrchestrationV2WorkflowPhase> {
  if (!Array.isArray(value)) return [];
  const phases: OrchestrationV2WorkflowPhase[] = [];
  value.forEach((entry, position) => {
    const record = readRecord(entry);
    if (record === undefined) return;
    const title = readString(record, ["title", "name"]);
    // A phase with no title is not renderable and would show as a blank pip.
    if (title === undefined) return;
    const declaredIndex = readCount(record, ["index"]);
    const detail = readString(record, ["detail", "description"]);
    phases.push({
      // Fall back to array position when the emitter omits an index, so pips
      // stay stably keyed.
      index: declaredIndex ?? position,
      title,
      ...(detail === undefined ? {} : { detail }),
    });
  });
  return phases;
}

export function claudeWorkflowProgressFromMessage(
  message: unknown,
): OrchestrationV2WorkflowProgress | undefined {
  const record = readRecord(message);
  if (record === undefined) return undefined;
  // Workflow metadata may arrive nested under `workflow` or flattened onto
  // the message; prefer the nested object when present.
  const workflow = readRecord(readAny(record, ["workflow", "workflow_meta", "workflowMeta"]));
  const source = workflow ?? record;

  const phases = readPhases(readAny(source, ["phases", "workflow_phases", "workflowPhases"]));
  const name = readString(source, ["name", "workflow_name", "workflowName"]);
  const description = readString(source, ["description"]);
  const currentPhase = readString(source, ["current_phase", "currentPhase", "phase"]);
  const spawnedCount = readCount(source, ["spawned_count", "spawnedCount", "agent_count"]);

  // Nothing workflow-shaped here: an ordinary subagent, not a script run.
  if (
    phases.length === 0 &&
    name === undefined &&
    currentPhase === undefined &&
    spawnedCount === undefined
  ) {
    return undefined;
  }

  return {
    phases,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(currentPhase === undefined ? {} : { currentPhase }),
    ...(spawnedCount === undefined ? {} : { spawnedCount }),
  };
}

export function claudeRunHandlesFromMessage(
  message: unknown,
): OrchestrationV2RunHandles | undefined {
  const record = readRecord(message);
  if (record === undefined) return undefined;
  const handles = readRecord(readAny(record, ["run_handles", "runHandles"])) ?? record;

  const runId = readString(handles, ["run_id", "runId"]);
  const scriptPath = readString(handles, ["script_path", "scriptPath"]);
  const transcriptDir = readString(handles, ["transcript_dir", "transcriptDir"]);
  // Sanitized here, at the boundary, so a non-http URL never reaches storage
  // -- the client renders this as a link and cannot re-check it.
  const sessionUrl = sanitizeV2SessionUrl(readString(handles, ["session_url", "sessionUrl"]));

  if (
    runId === undefined &&
    scriptPath === undefined &&
    transcriptDir === undefined &&
    sessionUrl === undefined
  ) {
    return undefined;
  }

  return {
    ...(runId === undefined ? {} : { runId }),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    ...(transcriptDir === undefined ? {} : { transcriptDir }),
    ...(sessionUrl === undefined ? {} : { sessionUrl }),
  };
}
