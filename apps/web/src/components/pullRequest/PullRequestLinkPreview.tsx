import type { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { useRef, useState, type ComponentPropsWithoutRef, type ReactElement } from "react";

import { formatRelativeTimeLabel } from "~/timestampFormat";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestActorAvatar, resolvePullRequestState } from "./pullRequestPresentation";

interface PullRequestLinkPreviewTarget {
  readonly environmentId: EnvironmentId;
  readonly input: PullRequestRef;
}

type PullRequestLinkElement = ReactElement<ComponentPropsWithoutRef<"a">>;

export function PullRequestLinkPreview({
  link,
  originalUrl,
  target,
}: {
  link: PullRequestLinkElement;
  originalUrl: string;
  target: PullRequestLinkPreviewTarget;
}) {
  const [open, setOpen] = useState(false);
  const previewActionsRef = useRef<PreviewCardPrimitive.Root.Actions | null>(null);
  const detailQuery = useEnvironmentQuery(
    open
      ? pullRequestEnvironment.detail({
          environmentId: target.environmentId,
          input: target.input,
        })
      : null,
  );
  const detail = detailQuery.data;
  // A pull request that cannot be read reads like any other link: its URL in a tooltip.
  const showUrlTooltip = open && detail === null && detailQuery.error !== null;
  const state =
    detail === null
      ? null
      : resolvePullRequestState({ state: detail.state, isDraft: detail.isDraft });
  const authorLabel =
    detail?.author === null
      ? "ghost"
      : detail?.author.name && detail.author.name !== detail.author.login
        ? `${detail.author.name} (@${detail.author.login})`
        : (detail?.author.login ?? null);

  return (
    <PreviewCard open={open} onOpenChange={setOpen} actionsRef={previewActionsRef}>
      <Tooltip
        open={showUrlTooltip}
        onOpenChange={(nextOpen) => {
          // A scroll that dismisses the URL tooltip also cancels the card's delayed hover open,
          // but leaves a card that is already showing (or loading) its preview alone.
          if (!nextOpen && detail === null && (!open || detailQuery.error !== null)) {
            previewActionsRef.current?.close();
          }
        }}
      >
        <PreviewCardTrigger
          render={<TooltipTrigger render={link} />}
          delay={350}
          closeDelay={120}
        />
        <TooltipPopup side="top">{originalUrl}</TooltipPopup>
      </Tooltip>
      {showUrlTooltip ? null : (
        <PreviewCardPopup align="center" className="w-80 max-w-[calc(100vw-2rem)] p-3">
          {detail === null ? (
            <p className="text-xs leading-relaxed text-muted-foreground wrap-anywhere">
              {detailQuery.isPending ? "Loading pull request details…" : originalUrl}
            </p>
          ) : (
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                <span className="min-w-0 truncate">{detail.repository}</span>
                <span className="shrink-0">#{detail.number}</span>
                <span aria-hidden>·</span>
                {state === null ? null : (
                  <span className="inline-flex shrink-0 items-center gap-1">
                    <state.Icon aria-hidden className={`size-3 ${state.toneClassName}`} />
                    {state.label}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm font-medium leading-snug text-foreground text-pretty">
                {detail.title}
              </p>
              <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <PullRequestActorAvatar actor={detail.author} className="size-4" />
                <span className="min-w-0 truncate">{authorLabel}</span>
                <span aria-hidden>·</span>
                <span className="shrink-0">opened {formatRelativeTimeLabel(detail.createdAt)}</span>
              </div>
            </div>
          )}
        </PreviewCardPopup>
      )}
    </PreviewCard>
  );
}
