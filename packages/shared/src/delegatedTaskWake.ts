// The orchestrator wakes a parent thread with a templated agent-authored user
// message when a delegated task settles (Orchestrator.delegatedTaskWakeDetail).
// Clients parse it back so the timeline can show "title — status" instead of
// the raw task_status boilerplate. Anything that doesn't match renders as-is.

export interface DelegatedTaskWakeMessage {
  /** Task title (or the raw task id when the task was untitled). */
  readonly title: string;
  readonly taskId: string;
  /** "completed", or the raw terminal status word (failed/cancelled/…). */
  readonly status: string;
}

const COMPLETED_PATTERN =
  /^Delegated task (?:"([\s\S]+)"|(\S+)) completed\. Use task_status with taskId (\S+) to read the result\.$/;
const ENDED_PATTERN =
  /^Delegated task (?:"([\s\S]+)"|(\S+)) ended with status (\S+)\. Use task_status with taskId (\S+) for details\.$/;

export function parseDelegatedTaskWakeMessage(text: string): DelegatedTaskWakeMessage | null {
  const trimmed = text.trim();
  const completed = COMPLETED_PATTERN.exec(trimmed);
  if (completed !== null) {
    return {
      title: completed[1] ?? completed[2] ?? "",
      taskId: completed[3] ?? "",
      status: "completed",
    };
  }
  const ended = ENDED_PATTERN.exec(trimmed);
  if (ended !== null) {
    return {
      title: ended[1] ?? ended[2] ?? "",
      taskId: ended[4] ?? "",
      status: ended[3] ?? "",
    };
  }
  return null;
}

/**
 * Plural cohort wake: several delegated tasks reached terminal states around
 * the same time and share one follow-up turn. Each entry keeps the same
 * title/status/taskId shape the singular form parses to, so clients render a
 * cohort as a list of the rows they already know how to draw.
 */
const COHORT_PATTERN =
  /^Delegated tasks (.+) reached terminal states\. Use task_status with each taskId to read the results\.$/;
const COHORT_ENTRY_PATTERN = /^(?:"([\s\S]+)"|(\S+)) \(([^,()]+), taskId (\S+)\)$/;

/**
 * Split on the commas that separate entries. Commas inside a quoted title and
 * inside an entry's own `(status, taskId ...)` group are part of the entry.
 */
function splitCohortEntries(value: string): ReadonlyArray<string> {
  const entries: Array<string> = [];
  let current = "";
  let quoted = false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '"') {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (!quoted && character === "(") {
      depth += 1;
    } else if (!quoted && character === ")" && depth > 0) {
      depth -= 1;
    } else if (character === "," && !quoted && depth === 0) {
      entries.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) {
    entries.push(current.trim());
  }
  return entries;
}

/**
 * Every task a wake message covers. Singular wakes yield one entry; anything
 * that does not match yields null so the raw text renders as-is.
 */
export function parseDelegatedTaskWakeMessages(
  text: string,
): ReadonlyArray<DelegatedTaskWakeMessage> | null {
  const single = parseDelegatedTaskWakeMessage(text);
  if (single !== null) {
    return [single];
  }
  const cohort = COHORT_PATTERN.exec(text.trim());
  if (cohort === null) {
    return null;
  }
  const parsed: Array<DelegatedTaskWakeMessage> = [];
  for (const entry of splitCohortEntries(cohort[1] ?? "")) {
    const match = COHORT_ENTRY_PATTERN.exec(entry);
    if (match === null) {
      return null;
    }
    parsed.push({
      title: match[1] ?? match[2] ?? "",
      taskId: match[4] ?? "",
      status: match[3] ?? "",
    });
  }
  return parsed.length > 0 ? parsed : null;
}

/**
 * Renders the wake text the orchestrator sends. One task keeps the original
 * singular sentence so older clients (and the singular parser) are unaffected.
 */
export function formatDelegatedTaskWakeMessage(
  tasks: ReadonlyArray<{
    readonly id: string;
    readonly title: string | null;
    readonly status: string;
  }>,
): string {
  const label = (task: (typeof tasks)[number]) =>
    task.title === null || task.title.length === 0 ? task.id : `"${task.title}"`;
  const only = tasks[0];
  if (tasks.length === 1 && only !== undefined) {
    return only.status === "completed"
      ? `Delegated task ${label(only)} completed. Use task_status with taskId ${only.id} to read the result.`
      : `Delegated task ${label(only)} ended with status ${only.status}. Use task_status with taskId ${only.id} for details.`;
  }
  const entries = tasks
    .map((task) => `${label(task)} (${task.status}, taskId ${task.id})`)
    .join(", ");
  return `Delegated tasks ${entries} reached terminal states. Use task_status with each taskId to read the results.`;
}
