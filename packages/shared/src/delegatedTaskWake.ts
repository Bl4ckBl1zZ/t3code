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
