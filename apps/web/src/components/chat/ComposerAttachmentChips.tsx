/**
 * The composer's pending-attachment row.
 *
 * Previously this assumed every attachment was an image; a PDF rendered as a
 * generic glyph with a truncated name and no size. Now that any file type can be
 * attached, non-images get a proper chip, and the row is reachable by keyboard.
 */
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { formatAttachmentSize, middleTruncateFileName } from "@t3tools/shared/composerAttachments";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PierreEntryIcon } from "./PierreEntryIcon";
import {
  attachmentKindLabel,
  duplicateAttachmentNames,
  resolveFocusAfterRemoval,
  shouldShowAttachmentSlotCounter,
} from "./ComposerAttachmentChips.logic";

const NAME_MAX_CHARS = 26;

export interface ComposerAttachmentChip {
  readonly id: string;
  readonly type: "image" | "video" | "pdf" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly previewUrl?: string | undefined;
}

export function ComposerAttachmentChips(props: {
  readonly attachments: ReadonlyArray<ComposerAttachmentChip>;
  readonly nonPersistedIds: ReadonlySet<string>;
  readonly onRemove: (id: string) => void;
  readonly onPreview: (id: string) => void;
  readonly onFocusEditor: () => void;
  readonly className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const [announcement, setAnnouncement] = useState("");
  const chipRefs = useRef(new Map<string, HTMLElement>());
  const duplicates = duplicateAttachmentNames(props.attachments);
  const count = props.attachments.length;

  const removeAt = useCallback(
    (id: string, moveFocus: boolean) => {
      const attachment = props.attachments.find((candidate) => candidate.id === id);
      const nextFocusId = resolveFocusAfterRemoval(
        props.attachments.map((candidate) => candidate.id),
        id,
      );
      props.onRemove(id);
      setAnnouncement(`${attachment?.name ?? "Attachment"} removed`);
      if (!moveFocus) return;
      // Focus has to survive the removal or the user is dropped back to the top
      // of the document mid-cleanup.
      requestAnimationFrame(() => {
        if (nextFocusId === null) {
          props.onFocusEditor();
          return;
        }
        chipRefs.current.get(nextFocusId)?.focus();
      });
    },
    [props],
  );

  if (count === 0) return null;

  return (
    <div className={cn("mb-3", props.className)}>
      <div className="flex flex-wrap items-center gap-2" role="list">
        {props.attachments.map((attachment) => {
          const isMedia =
            (attachment.type === "image" || attachment.type === "video") &&
            attachment.previewUrl !== undefined;
          const label = `${attachment.name}, ${attachmentKindLabel(attachment)}, ${formatAttachmentSize(
            attachment.sizeBytes,
          )}`;
          return (
            <div
              key={attachment.id}
              role="listitem"
              className={cn(
                "group/chip relative h-16 overflow-hidden rounded-lg border border-border/80 bg-background",
                isMedia ? "w-16" : "min-w-[168px] max-w-[240px]",
              )}
            >
              {isMedia && attachment.type === "image" ? (
                <button
                  type="button"
                  ref={(node) => {
                    if (node) chipRefs.current.set(attachment.id, node);
                    else chipRefs.current.delete(attachment.id);
                  }}
                  className="h-full w-full cursor-zoom-in"
                  aria-label={`Preview ${label}`}
                  onClick={() => props.onPreview(attachment.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "Backspace" && event.key !== "Delete") return;
                    event.preventDefault();
                    removeAt(attachment.id, true);
                  }}
                >
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.name}
                    className="h-full w-full object-cover"
                  />
                </button>
              ) : isMedia ? (
                <video
                  src={attachment.previewUrl}
                  controls
                  playsInline
                  preload="metadata"
                  aria-label={label}
                  className="h-full w-full bg-black object-contain"
                />
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <div
                        ref={(node) => {
                          if (node) chipRefs.current.set(attachment.id, node);
                          else chipRefs.current.delete(attachment.id);
                        }}
                        tabIndex={0}
                        role="button"
                        aria-label={label}
                        className="flex h-full w-full items-center gap-2 px-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onKeyDown={(event) => {
                          if (event.key !== "Backspace" && event.key !== "Delete") return;
                          event.preventDefault();
                          removeAt(attachment.id, true);
                        }}
                      />
                    }
                  >
                    <PierreEntryIcon
                      pathValue={attachment.name}
                      kind="file"
                      theme={resolvedTheme}
                      className="size-6 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-xs"
                        // Keeps an RTL or bidi-marked name from flipping the row.
                        dir="ltr"
                        style={{ unicodeBidi: "plaintext" }}
                      >
                        {middleTruncateFileName(attachment.name, NAME_MAX_CHARS)}
                      </span>
                      <span className="block text-[11px] tabular-nums text-muted-foreground">
                        {attachmentKindLabel(attachment)} ·{" "}
                        {formatAttachmentSize(attachment.sizeBytes)}
                      </span>
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup side="top">{attachment.name}</TooltipPopup>
                </Tooltip>
              )}

              {props.nonPersistedIds.has(attachment.id) && (
                <ChipBadge label="Draft attachment may not persist">
                  Draft attachment could not be saved locally and may be lost on navigation.
                </ChipBadge>
              )}
              {!props.nonPersistedIds.has(attachment.id) &&
                duplicates.has(attachment.name.toLowerCase()) && (
                  <ChipBadge label="Duplicate file name">
                    Another file in this message has the same name. They are saved separately, so
                    both are kept.
                  </ChipBadge>
                )}

              <Button
                variant="ghost"
                size="icon-xs"
                className={cn(
                  "absolute right-1 top-1 bg-background/80 hover:bg-background/90",
                  // Quiet on desktop, always reachable on touch.
                  "opacity-0 group-hover/chip:opacity-100 group-focus-within/chip:opacity-100 max-sm:opacity-100",
                )}
                onClick={() => removeAt(attachment.id, false)}
                aria-label={`Remove ${attachment.name}`}
              >
                <XIcon />
              </Button>
            </div>
          );
        })}

        {shouldShowAttachmentSlotCounter(count) && (
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
            {count} / {PROVIDER_SEND_TURN_MAX_ATTACHMENTS}
          </span>
        )}
      </div>
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}

function ChipBadge(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={props.label}
            className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
          >
            <CircleAlertIcon className="size-3" />
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-64 whitespace-normal leading-tight">
        {props.children}
      </TooltipPopup>
    </Tooltip>
  );
}
