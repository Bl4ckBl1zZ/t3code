/**
 * Scheduler-initiated user messages carry no dedicated input intent; the only
 * stable marker is the message id the scheduler mints
 * (`scheduled-task-message:<fireKey>` — see ScheduledTaskService). Keying off
 * that prefix lets the feed badge automation-fired prompts without a contract
 * change.
 */
const SCHEDULED_TASK_MESSAGE_ID_PREFIX = "scheduled-task-message:";

export function isScheduledTaskMessageId(messageId: string): boolean {
  return messageId.startsWith(SCHEDULED_TASK_MESSAGE_ID_PREFIX);
}
