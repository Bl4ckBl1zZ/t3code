/**
 * A non-media attachment inside a sent message bubble.
 *
 * The composer already renders pending files as an icon plus name plus
 * "KIND · size" (see `ComposerAttachmentChips`), but sending them collapsed all
 * of that to a bare centered filename — so eight crash reports arrived as eight
 * identical-looking blocks of text with no type, no size, and no icon. This puts
 * the sent bubble back in step with the composer, using the same
 * `PierreEntryIcon`, the same label helper, and the same middle truncation.
 *
 * Covers images and videos too, but only when their preview bytes are gone: an
 * attachment with no `previewUrl` is unrenderable as media, and a labelled file
 * row says more than a stretched empty box.
 */
import type { ChatAttachment } from "@t3tools/contracts";
import { formatAttachmentSize, middleTruncateFileName } from "@t3tools/shared/composerAttachments";

import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { attachmentKindLabel } from "./ComposerAttachmentChips.logic";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Matches the composer chip, so the same name truncates the same way in both. */
const NAME_MAX_CHARS = 26;

export function MessageFileAttachmentTile(props: {
  readonly attachment: Pick<ChatAttachment, "type" | "name" | "mimeType" | "sizeBytes"> & {
    readonly previewUrl?: string | undefined;
  };
  readonly className?: string;
}) {
  const { attachment } = props;
  const { resolvedTheme } = useTheme();
  const kind = attachmentKindLabel(attachment);
  const size = formatAttachmentSize(attachment.sizeBytes);

  const body = (
    <>
      <PierreEntryIcon
        pathValue={attachment.name}
        kind="file"
        theme={resolvedTheme}
        className="size-6 shrink-0"
      />
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-xs text-foreground"
          // Keeps an RTL or bidi-marked name from flipping the row.
          dir="ltr"
          style={{ unicodeBidi: "plaintext" }}
        >
          {middleTruncateFileName(attachment.name, NAME_MAX_CHARS)}
        </span>
        <span className="block text-[11px] tabular-nums text-muted-foreground">
          {kind} · {size}
        </span>
      </span>
    </>
  );

  const shared = cn("flex min-h-[60px] items-center gap-2 px-2.5 py-2 text-left", props.className);

  // The full name goes on the tooltip because the visible one is truncated, and
  // on the accessible name because a screen reader should not have to read the
  // ellipsis either.
  if (attachment.previewUrl === undefined) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<div className={shared} aria-label={`${attachment.name}, ${kind}, ${size}`} />}
        >
          {body}
        </TooltipTrigger>
        <TooltipPopup side="top">{attachment.name}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={attachment.previewUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${attachment.name}, ${kind}, ${size}`}
            className={cn(
              shared,
              "outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
            )}
          />
        }
      >
        {body}
      </TooltipTrigger>
      <TooltipPopup side="top">{attachment.name}</TooltipPopup>
    </Tooltip>
  );
}
