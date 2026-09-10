import type { ScopedThreadRef, ThreadLinkedPullRequest } from "@t3tools/contracts";
import { linkedPullRequestsOf, linkedPullRequestKey } from "@t3tools/shared/threadPullRequests";
import { GitPullRequestIcon, LinkIcon, PlusIcon, UnlinkIcon } from "lucide-react";
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
import { PullRequestDiffStat, PullRequestStateGlyph } from "./pullRequestPresentation";

function LinkRow({
  threadRef,
  link,
}: {
  threadRef: ScopedThreadRef;
  link: ThreadLinkedPullRequest;
}) {
  const query = useEnvironmentQuery(
    linkedPullRequestDetailAtom({ environmentId: threadRef.environmentId, input: link }),
  );
  const open = useOpenPrLink(threadRef);
  const linking = usePullRequestLinking(threadRef.environmentId);
  const [pending, setPending] = useState(false);
  const detail = query.data;
  return (
    <div className="flex items-center gap-2 rounded-md p-2 hover:bg-accent/60">
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
          #{link.number} {detail?.title ?? link.repository}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {query.error
            ? "Host state unavailable"
            : detail
              ? `${link.repository} · ${detail.headBranch} → ${detail.baseBranch}`
              : "Loading host state…"}
        </span>
      </a>
      {detail ? (
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
        aria-label={`Unlink #${link.number}`}
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

/** Queries host summaries only while the collection is visible. */
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
              links.map((link) => (
                <LinkRow key={linkedPullRequestKey(link)} threadRef={threadRef} link={link} />
              ))
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
