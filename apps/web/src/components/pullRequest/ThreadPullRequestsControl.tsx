import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import {
  resolveThreadPullRequestChains,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequestChains";
import { pullRequestListLines } from "./pullRequestListLines";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import type {
  ScopedThreadRef,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  allThreadPullRequestsOf,
  linkedPullRequestsOf,
  linkedPullRequestKey,
} from "@t3tools/shared/threadPullRequests";
import { GitPullRequestIcon, LayersIcon, LinkIcon, PlusIcon, UnlinkIcon } from "lucide-react";
import { useState } from "react";
import { useThreadShell, useServerConfigs } from "~/state/entities";
import { linkedPullRequestDetailAtom } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { Popover, PopoverTrigger, PopoverPopup } from "../ui/popover";
import { openLinkPullRequestDialog } from "./LinkPullRequestDialog";
import {
  PullRequestDiffStat,
  PullRequestStateGlyph,
  pullRequestChecksStatePresentation,
} from "./pullRequestPresentation";

const SOURCE_LABELS = {
  manual: "Linked by you",
  created: "Created from this thread",
  agent: "Linked by the agent",
  stack: "Found in the stack",
  "stack-dismissed": "Dismissed",
} as const;

function LinkRow({
  threadRef,
  link,
  metadata,
  depth = 0,
  stack,
}: {
  threadRef: ScopedThreadRef;
  link: ThreadLinkedPullRequest;
  metadata?: ThreadPullRequestLink | undefined;
  depth?: number;
  stack?: { kind: "native" | "derived"; size: number } | null;
}) {
  const query = useEnvironmentQuery(
    metadata !== undefined
      ? null
      : linkedPullRequestDetailAtom({ environmentId: threadRef.environmentId, input: link }),
  );
  const open = useOpenPrLink(threadRef);
  const linking = usePullRequestLinking(threadRef.environmentId);
  const [pending, setPending] = useState(false);
  const detail = metadata?.snapshot ?? query.data;
  const checks = metadata?.snapshot?.checksState
    ? pullRequestChecksStatePresentation(metadata.snapshot.checksState)
    : null;
  return (
    <div
      className="flex items-center gap-2 rounded-md p-2 hover:bg-accent/60"
      style={{ paddingLeft: `${0.5 + Math.min(depth, 3) * 1.25}rem` }}
    >
      {depth > 0 ? <span aria-hidden className="-ml-2 h-6 w-px shrink-0 bg-border/70" /> : null}
      {detail ? (
        <PullRequestStateGlyph state={detail.state} isDraft={detail.isDraft} />
      ) : (
        <GitPullRequestIcon className="size-4 shrink-0 text-muted-foreground" />
      )}
      <a
        className="min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        href={link.url}
        onClick={(event) => open(event, link.url)}
      >
        <span className="block truncate text-sm">
          <Tooltip>
            <TooltipTrigger render={<span />}>#{link.number}</TooltipTrigger>
            <TooltipPopup>
              {metadata
                ? `${SOURCE_LABELS[metadata.source]} · ${formatRelativeTimeLabel(metadata.linkedAt)}`
                : link.repository}
            </TooltipPopup>
          </Tooltip>{" "}
          {detail?.title ?? link.repository}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {query.error
            ? "Host state unavailable"
            : detail
              ? `${link.repository} · ${detail.headBranch} → ${detail.baseBranch}`
              : metadata
                ? "Waiting for host state…"
                : "Loading host state…"}
        </span>
        {metadata ? (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {stack ? (
              <>
                <LayersIcon className="size-3" />
                {stack.size} {stack.kind === "native" ? "in stack" : "in branch chain"} ·{" "}
              </>
            ) : null}
            {SOURCE_LABELS[metadata.source]}
            {detail?.author ? ` · ${detail.author.login}` : ""}
          </span>
        ) : null}
      </a>
      {checks ? (
        <checks.Icon
          role="img"
          aria-label={checks.label}
          className={`size-3.5 shrink-0 ${checks.toneClassName}`}
        />
      ) : null}
      {detail && detail.additions !== undefined && detail.deletions !== undefined ? (
        <PullRequestDiffStat
          additions={detail.additions}
          deletions={detail.deletions}
          className="text-xs"
        />
      ) : null}
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={pending}
        aria-label={`${metadata?.source === "stack" ? "Dismiss" : "Unlink"} #${link.number}`}
        onClick={() => {
          setPending(true);
          void linking
            .unlink(threadRef, link)
            .catch((error) =>
              toastManager.add({
                type: "error",
                title: "Could not unlink pull request",
                description: String(error),
              }),
            )
            .finally(() => setPending(false));
        }}
      >
        <UnlinkIcon className="size-3.5" />
      </Button>
    </div>
  );
}

/** V2 snapshots render immediately; older environments query only while the list is open. */
export function ThreadPullRequestsControl({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const configs = useServerConfigs();
  const [open, setOpen] = useState(false);
  if (
    !thread ||
    configs.get(threadRef.environmentId)?.environment.capabilities.threadPullRequestsV2 !== true
  )
    return null;
  const links = linkedPullRequestsOf(thread);
  const lines = pullRequestListLines(
    resolveThreadPullRequestChains(visibleThreadPullRequests(allThreadPullRequestsOf(thread))),
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" aria-label={`Linked pull requests (${links.length})`} />
        }
      >
        <LinkIcon className="size-3.5" />
        <span className="tabular-nums">{links.length}</span>
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[min(28rem,calc(100vw-2rem))]">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Linked pull requests</h3>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setOpen(false);
              openLinkPullRequestDialog(threadRef);
            }}
            disabled={links.length >= 50}
          >
            <PlusIcon className="size-3.5" />
            Link
          </Button>
        </div>
        {open ? (
          <div className="max-h-80 overflow-y-auto">
            {links.length ? (
              lines.map((line) => {
                const link = links.find(
                  (candidate) =>
                    linkedPullRequestKey(candidate) ===
                    `${line.link.host}/${line.link.repository}#${line.link.number}`,
                ) ?? {
                  projectId: line.link.projectId ?? thread.projectId,
                  repository: line.link.repository,
                  number: line.link.number,
                  url: line.link.url,
                };
                return (
                  <LinkRow
                    key={linkedPullRequestKey(link)}
                    threadRef={threadRef}
                    link={link}
                    metadata={thread.pullRequests === undefined ? undefined : line.link}
                    depth={line.depth}
                    stack={line.stack}
                  />
                );
              })
            ) : (
              <p className="py-3 text-sm text-muted-foreground">
                Link pull requests to keep this thread's reviews together.
              </p>
            )}
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
