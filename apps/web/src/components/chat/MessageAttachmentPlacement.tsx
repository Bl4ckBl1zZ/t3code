/**
 * Shows where an uploaded file landed in the user's project.
 *
 * Uploads are written into `.t3code/uploads/` so the agent can open them with
 * its own file tools. Surfacing the path closes the loop: the user can open the
 * file, copy the path, and see that the agent has it.
 *
 * Renders nothing at all when the server did not materialize the attachment,
 * which is the normal state for a conversation with no project attached. Only a
 * real write failure gets a visible warning.
 */
import type { ChatAttachment } from "@t3tools/contracts";
import { CircleAlertIcon, CopyIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function MessageAttachmentPlacement(props: {
  readonly attachment: ChatAttachment;
  readonly onOpenWorkspaceFile?: ((workspacePath: string) => void) | undefined;
  readonly onCopyPath?: ((workspacePath: string) => void) | undefined;
  readonly className?: string;
}) {
  const { attachment } = props;

  if (attachment.materialization === "failed") {
    const reason =
      attachment.materializationReason ??
      "T3 couldn't write this file into your project, so the agent received its contents in the message instead.";
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              // Also on the title so the reason is reachable without a hover.
              title={reason}
              className={cn(
                "flex items-center gap-1 px-2 py-1 text-[11px] text-amber-600",
                props.className,
              )}
            >
              <CircleAlertIcon className="size-3 shrink-0" aria-hidden="true" />
              Not saved to the workspace
            </span>
          }
        />
        <TooltipPopup side="top" className="max-w-72 whitespace-normal leading-tight">
          {reason}
        </TooltipPopup>
      </Tooltip>
    );
  }

  const workspacePath = attachment.workspacePath;
  if (workspacePath === undefined) return null;

  return (
    <div className={cn("flex items-center gap-1 px-1.5 py-1", props.className)}>
      <button
        type="button"
        title={`Open ${workspacePath}`}
        aria-label={`Open ${workspacePath}`}
        disabled={props.onOpenWorkspaceFile === undefined}
        onClick={() => props.onOpenWorkspaceFile?.(workspacePath)}
        className="min-w-0 flex-1 rounded px-1 py-0.5 text-left font-mono text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:hover:text-muted-foreground"
      >
        {/* Truncate from the left: the file name matters more than `.t3code/uploads`. */}
        <span className="block truncate [direction:rtl] [text-align:left]">{workspacePath}</span>
      </button>
      {props.onCopyPath !== undefined && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Copy path for ${attachment.name}`}
          onClick={() => props.onCopyPath?.(workspacePath)}
        >
          <CopyIcon />
        </Button>
      )}
    </div>
  );
}
