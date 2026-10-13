import type {
  OrchestrationV2BackgroundTaskOutput,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import {
  presentBackgroundTaskOutput,
  presentPendingBackgroundWork,
  type PendingBackgroundWorkItem,
} from "@t3tools/client-runtime/state/thread-execution";
import { BotIcon, EyeIcon, SquareTerminalIcon, type LucideIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";
import { useBackgroundOutputClock } from "./useThreadBackgroundOutput";

const KIND_ICON: Record<PendingBackgroundWorkItem["kind"], LucideIcon> = {
  subagent: BotIcon,
  command: SquareTerminalIcon,
  monitor: EyeIcon,
  background_task: SquareTerminalIcon,
};

/**
 * Thread details section for work a settled thread left running: commands such
 * as a dev server, monitors waiting on a condition, and subagents. Shows how
 * long each has run and the last line a command printed, so a stuck command is
 * told apart from a working one without opening a terminal. Renders nothing
 * when nothing runs.
 */
export function ThreadBackgroundPanel(props: {
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly outputs: ReadonlyMap<string, OrchestrationV2BackgroundTaskOutput>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const presentation = presentPendingBackgroundWork(props.tasks);
  if (presentation === null) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-background-heading"
      title="Background"
      data-thread-background-panel
    >
      <ul className="m-0 list-none p-0">
        {presentation.items.map((item) => (
          <BackgroundWorkRow
            key={item.taskId}
            item={item}
            output={props.outputs.get(item.taskId)}
            onOpenThread={props.onOpenThread}
          />
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}

function BackgroundWorkRow(props: {
  readonly item: PendingBackgroundWorkItem;
  readonly output: OrchestrationV2BackgroundTaskOutput | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { item } = props;
  const output = presentBackgroundTaskOutput(props.output, useBackgroundOutputClock(props.output));
  const Icon = KIND_ICON[item.kind];
  const childThreadId = item.childThreadId;
  const meta = [output.elapsed, output.deadline].filter((part) => part !== null).join(" · ");
  return (
    <li
      className={cn("flex items-start rounded-lg py-1.5", THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS)}
    >
      <Icon className={cn(THREAD_DETAILS_PANEL_ICON_CLASS, "mt-px")} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          {childThreadId === undefined ? (
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/80">
              {item.label}
            </span>
          ) : (
            <button
              type="button"
              className="min-w-0 flex-1 cursor-pointer truncate text-left text-sm font-medium text-foreground/80 hover:text-foreground hover:underline"
              aria-label={`Open subagent ${item.label}`}
              onClick={() => props.onOpenThread(childThreadId)}
            >
              {item.label}
            </button>
          )}
          {meta.length > 0 ? (
            <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{meta}</span>
          ) : null}
        </div>
        {output.lastLine !== null ? (
          <p className="flex min-w-0 gap-1.5 text-2xs text-muted-foreground">
            <span className="min-w-0 truncate font-mono">{output.lastLine}</span>
            {output.lastOutputAgo !== null ? (
              <span className="shrink-0 tabular-nums">{output.lastOutputAgo}</span>
            ) : null}
          </p>
        ) : item.kind === "command" && props.output?.startedAt !== undefined ? (
          <p className="text-2xs text-muted-foreground">No output yet</p>
        ) : null}
      </div>
    </li>
  );
}
