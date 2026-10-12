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
  type OrchestrationV2WorkflowAgent,
  type OrchestrationV2WorkflowPhase,
  type OrchestrationV2WorkflowProgress,
  sanitizeV2SessionUrl,
} from "@t3tools/contracts";

import { field, text } from "../unknownField.ts";

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

/** The task type Claude reports for a Workflow tool run. */
export const CLAUDE_WORKFLOW_TASK_TYPE = "local_workflow";

/**
 * Whether a task frame carries Claude's workflow roster: `workflow_progress`
 * is a replace-in-full list of `workflow_phase` and `workflow_agent` entries.
 */
export function hasClaudeWorkflowSnapshot(
  message: unknown,
): message is { readonly workflow_progress: ReadonlyArray<unknown> } {
  const entries = field(message, "workflow_progress");
  return Array.isArray(entries) && entries.length > 0;
}

const AGENT_STATES: Record<string, OrchestrationV2WorkflowAgent["state"] | undefined> = {
  queued: "queued",
  start: "running",
  done: "completed",
  error: "failed",
};

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Epoch milliseconds a DateTime can hold; anything larger is dropped. */
function timestamp(value: unknown): number | undefined {
  const milliseconds = count(value);
  return milliseconds !== undefined && milliseconds <= 8_640_000_000_000_000
    ? milliseconds
    : undefined;
}

/** Excerpts keep their whitespace: an answer may be indented code. */
function preview(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseSnapshotPhase(entry: unknown): OrchestrationV2WorkflowPhase | null {
  const index = count(field(entry, "index"));
  const title = text(field(entry, "title"));
  return index === undefined || title === undefined ? null : { index, title };
}

function parseSnapshotAgent(entry: unknown): OrchestrationV2WorkflowAgent | null {
  const index = count(field(entry, "index"));
  const label = text(field(entry, "label"));
  if (index === undefined || label === undefined) return null;
  // An unknown state is in-flight, not settled: guessing "completed" would
  // freeze a live row, while guessing "running" self-corrects on the next frame.
  const reportedState = text(field(entry, "state")) ?? "";
  const state = Object.hasOwn(AGENT_STATES, reportedState)
    ? (AGENT_STATES[reportedState] ?? "running")
    : "running";
  const agentId = text(field(entry, "agentId"));
  const phaseIndex = count(field(entry, "phaseIndex"));
  const phaseTitle = text(field(entry, "phaseTitle"));
  const model = text(field(entry, "model"));
  const attempt = count(field(entry, "attempt"));
  const totalTokens = count(field(entry, "tokens"));
  const toolCalls = count(field(entry, "toolCalls"));
  const durationMs = count(field(entry, "durationMs"));
  const queuedAt = timestamp(field(entry, "queuedAt"));
  const startedAt = timestamp(field(entry, "startedAt"));
  const prompt = preview(field(entry, "promptPreview"));
  const result = preview(field(entry, "resultPreview"));
  return {
    index,
    label,
    state,
    ...(agentId === undefined ? {} : { agentId }),
    ...(phaseIndex === undefined ? {} : { phaseIndex }),
    ...(phaseTitle === undefined ? {} : { phaseTitle }),
    ...(model === undefined ? {} : { model }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(queuedAt === undefined ? {} : { queuedAt }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(result === undefined ? {} : { result }),
  };
}

function parseClaudeWorkflowSnapshot(message: unknown): {
  readonly phases: ReadonlyArray<OrchestrationV2WorkflowPhase>;
  readonly agents: ReadonlyArray<OrchestrationV2WorkflowAgent>;
} | null {
  if (!hasClaudeWorkflowSnapshot(message)) return null;
  const phases: OrchestrationV2WorkflowPhase[] = [];
  const agents: OrchestrationV2WorkflowAgent[] = [];
  for (const entry of message.workflow_progress) {
    const type = text(field(entry, "type"));
    if (type === "workflow_phase") {
      const phase = parseSnapshotPhase(entry);
      if (phase !== null) phases.push(phase);
    } else if (type === "workflow_agent") {
      const agent = parseSnapshotAgent(entry);
      if (agent !== null) agents.push(agent);
    }
  }
  return phases.length === 0 && agents.length === 0 ? null : { phases, agents };
}

/**
 * Reads the Workflow tool's structured result. A background launch answers the
 * model with an acknowledgement rather than the run's output, and that
 * acknowledgement is the only place the run's filesystem handles appear —
 * nothing later on the event stream repeats them.
 */
export function claudeWorkflowRunHandlesFromToolResult(
  toolUseResult: unknown,
): OrchestrationV2RunHandles | undefined {
  if (text(field(toolUseResult, "taskType")) !== CLAUDE_WORKFLOW_TASK_TYPE) return undefined;
  return claudeRunHandlesFromMessage(toolUseResult);
}

/**
 * The phase a roster is in: the latest phase a running member belongs to, or,
 * when none is running, the latest phase any member reached.
 */
function rosterCurrentPhase(
  agents: ReadonlyArray<OrchestrationV2WorkflowAgent>,
): string | undefined {
  const phased = agents.filter((agent) => agent.phaseTitle !== undefined);
  const running = phased.filter((agent) => agent.state === "running");
  let latest: OrchestrationV2WorkflowAgent | undefined;
  for (const agent of running.length > 0 ? running : phased) {
    if (latest === undefined || (agent.phaseIndex ?? -1) >= (latest.phaseIndex ?? -1)) {
      latest = agent;
    }
  }
  return latest?.phaseTitle;
}

/**
 * Folds one task frame into the coordinator's workflow state.
 *
 * The roster is cumulative: a frame without a snapshot leaves it alone, a
 * phase only ever joins the plan (the provider re-sends the full plan on every
 * snapshot, but a late frame that omits an already-seen phase must not shorten
 * the arc), and a member keeps fields a later frame omits. A member's state
 * never regresses within one attempt; a higher attempt is a restart and starts
 * over, keeping only its phase link.
 *
 * Returns undefined when nothing identifies the task as a workflow. Progress
 * frames do not repeat `task_type`, so this is the single place that decides
 * whether a task is a coordinator; without it every ordinary subagent's frame
 * would mint an empty workflow.
 */
export function mergeClaudeWorkflowProgress(input: {
  readonly previous: OrchestrationV2WorkflowProgress | undefined;
  readonly message: unknown;
  /** The task reported the workflow task type, so it is one even before its roster. */
  readonly isWorkflow?: boolean;
}): OrchestrationV2WorkflowProgress | undefined {
  const { previous } = input;
  const reported = claudeWorkflowProgressFromMessage(input.message);
  const snapshot = parseClaudeWorkflowSnapshot(input.message);
  if (
    previous === undefined &&
    reported === undefined &&
    snapshot === null &&
    input.isWorkflow !== true
  ) {
    return undefined;
  }

  const phasesByIndex = new Map(
    (previous?.phases ?? []).map((phase) => [phase.index, phase] as const),
  );
  for (const phase of [...(reported?.phases ?? []), ...(snapshot?.phases ?? [])]) {
    const prior = phasesByIndex.get(phase.index);
    phasesByIndex.set(
      phase.index,
      phase.detail === undefined && prior?.detail !== undefined && prior.title === phase.title
        ? { ...phase, detail: prior.detail }
        : phase,
    );
  }

  const agentsByIndex = new Map(
    (previous?.agents ?? []).map((agent) => [agent.index, agent] as const),
  );
  for (const agent of snapshot?.agents ?? []) {
    const prior = agentsByIndex.get(agent.index);
    const attempt = agent.attempt ?? prior?.attempt ?? 1;
    if (prior !== undefined && attempt < (prior.attempt ?? 1)) continue;
    const restarted = prior !== undefined && attempt > (prior.attempt ?? 1);
    const regressed =
      !restarted &&
      (((prior?.state === "completed" || prior?.state === "failed") &&
        agent.state !== prior.state) ||
        (prior?.state === "running" && agent.state === "queued"));
    agentsByIndex.set(
      agent.index,
      regressed
        ? { ...agent, ...prior }
        : {
            ...(restarted
              ? {
                  ...(prior.phaseIndex === undefined ? {} : { phaseIndex: prior.phaseIndex }),
                  ...(prior.phaseTitle === undefined ? {} : { phaseTitle: prior.phaseTitle }),
                }
              : prior),
            ...agent,
          },
    );
  }
  const agents = Array.from(agentsByIndex.values()).sort((left, right) => left.index - right.index);

  // A task_progress description is the progress line, not the workflow's.
  const isProgressFrame = text(field(input.message, "subtype")) === "task_progress";
  const name = reported?.name ?? previous?.name;
  const description =
    (isProgressFrame ? undefined : reported?.description) ?? previous?.description;
  const currentPhase =
    reported?.currentPhase ??
    (snapshot !== null && snapshot.agents.length > 0 ? rosterCurrentPhase(agents) : undefined) ??
    previous?.currentPhase;
  const spawnedCount =
    reported?.spawnedCount ?? (agents.length > 0 ? agents.length : previous?.spawnedCount);
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    phases: Array.from(phasesByIndex.values()).sort((left, right) => left.index - right.index),
    ...(currentPhase === undefined ? {} : { currentPhase }),
    ...(spawnedCount === undefined ? {} : { spawnedCount }),
    agents,
  };
}
