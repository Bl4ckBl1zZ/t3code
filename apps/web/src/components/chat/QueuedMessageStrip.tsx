import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  ImageIcon,
  PencilIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

import type { MessageId } from "@t3tools/contracts";

import type { QueuedComposerMessage } from "~/queuedMessageStore";
import { cn } from "~/lib/utils";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface QueuedMessageStripProps {
  readonly queue: ReadonlyArray<QueuedComposerMessage>;
  readonly dispatchingMessageId: MessageId | null;
  readonly onDelete: (messageId: MessageId) => void;
  readonly onMove: (messageId: MessageId, direction: "up" | "down") => void;
  readonly onSavePrompt: (messageId: MessageId, prompt: string) => void;
  readonly onEditingChange: (messageId: MessageId, editing: boolean) => void;
}

/** Collapse a queued prompt to a single presentable line. */
export function queuedMessagePreview(message: QueuedComposerMessage): string {
  const firstLine =
    message.prompt
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  if (firstLine.length > 0) {
    return firstLine;
  }
  if (message.images.length > 0) {
    return message.images.length === 1
      ? `Image: ${message.images[0]!.name}`
      : `${message.images.length} images`;
  }
  if (message.terminalContexts.length > 0) {
    return "Terminal output";
  }
  if (message.elementContexts.length > 0 || message.previewAnnotations.length > 0) {
    return "Preview context";
  }
  if (message.reviewComments.length > 0) {
    return "Review comments";
  }
  return "Queued message";
}

const rowIconButtonClassName =
  "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30";

const QueuedMessageRow = memo(function QueuedMessageRow({
  message,
  index,
  count,
  isDispatching,
  onDelete,
  onMove,
  onSavePrompt,
  onEditingChange,
}: {
  readonly message: QueuedComposerMessage;
  readonly index: number;
  readonly count: number;
  readonly isDispatching: boolean;
  readonly onDelete: QueuedMessageStripProps["onDelete"];
  readonly onMove: QueuedMessageStripProps["onMove"];
  readonly onSavePrompt: QueuedMessageStripProps["onSavePrompt"];
  readonly onEditingChange: QueuedMessageStripProps["onEditingChange"];
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.prompt);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  // If the row starts dispatching (or is removed and re-added) while an editor
  // was open, the edit session is void — the payload underneath it is gone.
  useEffect(() => {
    if (isDispatching && isEditing) {
      setIsEditing(false);
      onEditingChange(message.id, false);
    }
  }, [isDispatching, isEditing, message.id, onEditingChange]);

  useEffect(() => {
    return () => {
      onEditingChange(message.id, false);
    };
    // Release only on unmount; onEditingChange is stable in the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginEdit = useCallback(() => {
    setEditValue(message.prompt);
    setIsEditing(true);
    onEditingChange(message.id, true);
    requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (editor) {
        editor.focus();
        editor.setSelectionRange(editor.value.length, editor.value.length);
      }
    });
  }, [message.id, message.prompt, onEditingChange]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    onEditingChange(message.id, false);
  }, [message.id, onEditingChange]);

  const saveEdit = useCallback(() => {
    const trimmed = editValue.trim();
    const hasOtherContent =
      message.images.length > 0 ||
      message.terminalContexts.length > 0 ||
      message.elementContexts.length > 0 ||
      message.previewAnnotations.length > 0 ||
      message.reviewComments.length > 0;
    // An empty prompt with no other payload would dispatch nothing — treat
    // saving it as deleting the row, which is what emptying a message means.
    if (trimmed.length === 0 && !hasOtherContent) {
      onDelete(message.id);
      return;
    }
    onSavePrompt(message.id, editValue);
    setIsEditing(false);
    onEditingChange(message.id, false);
  }, [editValue, message, onDelete, onEditingChange, onSavePrompt]);

  const preview = queuedMessagePreview(message);

  return (
    <div
      data-queued-message-row="true"
      className={cn(
        "group/queued-row flex min-w-0 items-start gap-2 rounded-xl border border-border/60 bg-muted/30 px-2.5 py-1.5 transition-colors",
        isDispatching ? "border-primary/40 bg-primary/5" : "hover:bg-muted/50",
        message.lastDispatchError ? "border-destructive/50" : null,
      )}
    >
      <div className="flex h-6 shrink-0 items-center text-muted-foreground/60">
        {isDispatching ? (
          <Spinner className="size-3.5" aria-label="Sending queued message" />
        ) : message.lastDispatchError ? (
          <AlertCircleIcon className="size-3.5 text-destructive" aria-hidden="true" />
        ) : (
          <ClockIcon className="size-3.5" aria-hidden="true" />
        )}
      </div>

      {isEditing ? (
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <textarea
            ref={editorRef}
            value={editValue}
            rows={Math.min(6, Math.max(2, editValue.split("\n").length))}
            className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary/60"
            aria-label="Edit queued message"
            onChange={(event) => setEditValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancelEdit();
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                saveEdit();
              }
            }}
          />
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-sm text-foreground/85">{preview}</span>
            {message.images.length > 0 ? (
              <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground/70">
                <ImageIcon className="size-3" aria-hidden="true" />
                {message.images.length}
              </span>
            ) : null}
          </div>
          {message.lastDispatchError ? (
            <span className="truncate text-xs text-destructive/90">
              {message.lastDispatchError} — edit to retry
            </span>
          ) : null}
        </div>
      )}

      <div
        className={cn(
          "flex shrink-0 items-center gap-0.5",
          isEditing
            ? null
            : "opacity-60 transition-opacity group-hover/queued-row:opacity-100 group-focus-within/queued-row:opacity-100",
        )}
      >
        {isEditing ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={rowIconButtonClassName}
                    aria-label="Save queued message"
                    onClick={saveEdit}
                  />
                }
              >
                <CheckIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Save</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={rowIconButtonClassName}
                    aria-label="Cancel editing"
                    onClick={cancelEdit}
                  />
                }
              >
                <XIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Cancel</TooltipPopup>
            </Tooltip>
          </>
        ) : (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={rowIconButtonClassName}
                    aria-label="Move queued message up"
                    disabled={isDispatching || index === 0}
                    onClick={() => onMove(message.id, "up")}
                  />
                }
              >
                <ChevronUpIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Send earlier</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={rowIconButtonClassName}
                    aria-label="Move queued message down"
                    disabled={isDispatching || index === count - 1}
                    onClick={() => onMove(message.id, "down")}
                  />
                }
              >
                <ChevronDownIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Send later</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={rowIconButtonClassName}
                    aria-label="Edit queued message"
                    disabled={isDispatching}
                    onClick={beginEdit}
                  />
                }
              >
                <PencilIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Edit</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={cn(rowIconButtonClassName, "hover:text-destructive")}
                    aria-label="Delete queued message"
                    disabled={isDispatching}
                    onClick={() => onDelete(message.id)}
                  />
                }
              >
                <Trash2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Delete</TooltipPopup>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
});

/**
 * Queued messages waiting for the current turn to finish, rendered directly
 * above the composer. Rows dispatch top-to-bottom; each can be edited,
 * deleted, or reordered until the moment it starts sending.
 */
export const QueuedMessageStrip = memo(function QueuedMessageStrip({
  queue,
  dispatchingMessageId,
  onDelete,
  onMove,
  onSavePrompt,
  onEditingChange,
}: QueuedMessageStripProps) {
  if (queue.length === 0) {
    return null;
  }

  return (
    <div
      data-queued-message-strip="true"
      className="mx-auto mb-2 flex w-full max-w-3xl flex-col gap-1.5"
      role="list"
      aria-label={`${queue.length} queued message${queue.length === 1 ? "" : "s"}`}
    >
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium text-muted-foreground/80">
          {queue.length} queued — sends when the agent finishes
        </span>
      </div>
      {queue.map((message, index) => (
        <div key={message.id} role="listitem">
          <QueuedMessageRow
            message={message}
            index={index}
            count={queue.length}
            isDispatching={dispatchingMessageId === message.id}
            onDelete={onDelete}
            onMove={onMove}
            onSavePrompt={onSavePrompt}
            onEditingChange={onEditingChange}
          />
        </div>
      ))}
    </div>
  );
});
