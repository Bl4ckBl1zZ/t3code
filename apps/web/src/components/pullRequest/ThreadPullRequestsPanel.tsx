import type { ProjectId, ScopedThreadRef, ThreadPullRequestLink } from "@t3tools/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";
import {
  resolveThreadPullRequestChains,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequestChains";
import {
  EyeIcon,
  EyeOffIcon,
  GitPullRequestArrow,
  LayersIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { findProjectForChangeRequest, useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { useShortcutModifierState } from "~/shortcutModifierState";
import { useProjects, useServerConfigs, useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { toastManager } from "../ui/toast";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openLinkPullRequestDialog } from "./LinkPullRequestDialog";
import { pullRequestListLines, type PullRequestListLine } from "./pullRequestListLines";
import {
  PullRequestActorAvatar,
  PullRequestDiffStat,
  PullRequestStateGlyph,
  pullRequestChecksStatePresentation,
} from "./pullRequestPresentation";
import { PullRequestSpeedActions } from "./PullRequestSpeedActions";

const SOURCE_LABELS: Record<ThreadPullRequestLink["source"], string> = {
  manual: "Linked by you",
  created: "Created from this thread",
  agent: "Linked by the agent",
  stack: "Found in the stack",
  "stack-dismissed": "Dismissed",
};

function ChecksGlyph({
  state,
}: {
  state: NonNullable<ThreadPullRequestLink["snapshot"]>["checksState"] & string;
}) {
  const presentation = pullRequestChecksStatePresentation(state);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <presentation.Icon
          role="img"
          aria-label={presentation.label}
          className={cn("size-3.5", presentation.toneClassName)}
        />
      </TooltipTrigger>
      <TooltipPopup>{presentation.label}</TooltipPopup>
    </Tooltip>
  );
}

function LinkRow({
  line,
  threadRef,
  projectId,
  onUnlink,
  onSetWatching,
}: {
  line: PullRequestListLine;
  threadRef: ScopedThreadRef;
  /** The project quick actions act through; null when this environment cannot act on it. */
  projectId: ProjectId | null;
  onUnlink: (link: ThreadPullRequestLink) => Promise<void>;
  /** Null when the environment cannot watch pull requests. */
  onSetWatching: ((link: ThreadPullRequestLink, watching: boolean) => void) | null;
}) {
  const openPrLink = useOpenPrLink(threadRef);
  // Right-click opens the row's actions menu at the pointer instead of under the "…" button.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuAnchor = useMemo(
    () =>
      menuPosition
        ? { getBoundingClientRect: () => new DOMRect(menuPosition.x, menuPosition.y, 0, 0) }
        : undefined,
    [menuPosition],
  );
  const { link, depth, stack } = line;
  const snapshot = link.snapshot;
  const [pending, setPending] = useState(false);
  const open = snapshot === null || snapshot.state === "open";
  const watching = link.watch !== undefined;
  // Quick actions, shown while Shift is held, need a known state and a GitHub pull request.
  const actionEntry =
    projectId !== null &&
    snapshot !== null &&
    snapshot.state !== "merged" &&
    detectSourceControlProviderFromRemoteUrl(link.url)?.kind === "github"
      ? {
          environmentId: threadRef.environmentId,
          projectId,
          host: link.host,
          repository: link.repository,
          number: link.number,
          state: snapshot.state,
          isDraft: snapshot.isDraft,
          provider: "github" as const,
        }
      : null;
  return (
    <div
      className="group/pr-row flex items-center gap-2 rounded-md py-1 pr-1 hover:bg-accent/60"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenuPosition({ x: event.clientX, y: event.clientY });
        setMenuOpen(true);
      }}
      // Each layer steps in under the one it targets. The step is capped: beyond a few layers
      // the indent only says "still in the stack", which the connector line already does, and
      // a sixteen-layer stack would otherwise stair-step off the right edge.
      style={{ paddingLeft: `${0.5 + Math.min(depth, 3) * 1.25}rem` }}
    >
      {depth > 0 ? <span aria-hidden className="-ml-2 h-6 w-px shrink-0 bg-border/70" /> : null}
      {snapshot === null ? (
        <GitPullRequestArrow
          aria-label="Waiting for host state"
          className="size-4 shrink-0 text-muted-foreground"
        />
      ) : (
        <PullRequestStateGlyph state={snapshot.state} isDraft={snapshot.isDraft} />
      )}
      <a
        href={link.url}
        onClick={(event) => openPrLink(event, link.url, threadRef)}
        className="min-w-0 flex-1"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground" />
              }
            >
              #{link.number}
            </TooltipTrigger>
            <TooltipPopup>
              {SOURCE_LABELS[link.source]} · {formatRelativeTimeLabel(link.linkedAt)}
            </TooltipPopup>
          </Tooltip>
          <span className="min-w-0 flex-1 truncate text-sm">
            {snapshot?.title ?? link.repository}
          </span>
          {/* Right-aligned signals, in the order a reviewer scans them: are checks green,
              has someone ruled, how big is it. Each is absent rather than neutral when the
              host said nothing, so a row without them reads as unknown, not as fine. */}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px]">
            {watching && open ? (
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
                  <EyeIcon role="img" aria-label="Watching" className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>
                  Watching: the agent wakes when checks finish, someone comments, or the branch
                  conflicts
                </TooltipPopup>
              </Tooltip>
            ) : null}
            {snapshot?.checksState ? <ChecksGlyph state={snapshot.checksState} /> : null}
            {snapshot?.state === "open" &&
            (snapshot.reviewDecision === "approved" ||
              snapshot.reviewDecision === "changes-requested") ? (
              <span
                className={cn(
                  snapshot.reviewDecision === "approved"
                    ? "text-emerald-600/90 dark:text-emerald-400/80"
                    : "text-amber-600/90 dark:text-amber-400/80",
                )}
              >
                {snapshot.reviewDecision === "approved" ? "Approved" : "Changes requested"}
              </span>
            ) : null}
            {snapshot?.state === "open" && snapshot.mergeability === "conflicting" ? (
              <span className="text-destructive">Conflicts</span>
            ) : null}
            {snapshot?.additions !== undefined && snapshot.deletions !== undefined ? (
              <PullRequestDiffStat
                additions={snapshot.additions}
                deletions={snapshot.deletions}
                className="font-mono"
              />
            ) : null}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {stack ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-foreground/70" />
                }
              >
                {stack.kind === "native" ? (
                  <LayersIcon aria-hidden className="size-3" />
                ) : (
                  <GitPullRequestArrow aria-hidden className="size-3" />
                )}
                {stack.size}
              </TooltipTrigger>
              <TooltipPopup>
                {stack.kind === "native"
                  ? `GitHub stack of ${stack.size}: merging a layer lands the ones below it.`
                  : `${stack.size} pull requests chained by base branch.`}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {snapshot?.author ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <PullRequestActorAvatar actor={snapshot.author} className="size-3.5" />
              <span className="max-w-28 truncate">{snapshot.author.login}</span>
            </span>
          ) : null}
          {snapshot !== null ? (
            <>
              {/* Cut in the middle: rows from one owner differ in the repository name at the
                  end, which a tail cut would hide. */}
              <Tooltip>
                <TooltipTrigger render={<span className="flex min-w-0 max-w-32 font-mono" />}>
                  <MiddleTruncate value={link.repository} showTitle={false} />
                </TooltipTrigger>
                <TooltipPopup>{link.repository}</TooltipPopup>
              </Tooltip>
              <span className="truncate font-mono">
                {`${snapshot.headBranch} → ${snapshot.baseBranch}`}
              </span>
            </>
          ) : (
            <span className="truncate font-mono">{`${link.host}/${link.repository}`}</span>
          )}
          {snapshot?.updatedAt ? (
            <span className="shrink-0">· {formatRelativeTimeLabel(snapshot.updatedAt)}</span>
          ) : null}
        </span>
      </a>
      {actionEntry !== null ? <PullRequestSpeedActions entry={actionEntry} /> : null}
      <Menu
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (!open) setMenuPosition(null);
        }}
      >
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Actions for #${link.number}`}
              className={cn(
                "opacity-100 sm:opacity-0 group-hover/pr-row:opacity-100 group-focus-within/pr-row:opacity-100 data-[popup-open]:opacity-100",
                "group-has-[[data-pull-request-action-pending=true]]/pr-row:hidden",
                actionEntry !== null && "group-data-[speed-actions]/pr-list:hidden",
              )}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          }
        />
        <MenuPopup
          anchor={menuAnchor}
          align={menuPosition ? "start" : "end"}
          side="bottom"
          sideOffset={menuPosition ? 0 : 4}
        >
          <MenuItem onClick={() => void writeTextToClipboard(link.url, "link")}>Copy link</MenuItem>
          <MenuItem onClick={(event) => openPrLink(event, link.url, threadRef)}>Open</MenuItem>
          {onSetWatching !== null && open ? (
            <MenuItem onClick={() => onSetWatching(link, !watching)}>
              {watching ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
              {watching ? "Stop watching" : "Watch for changes"}
            </MenuItem>
          ) : null}
          <MenuItem
            disabled={pending}
            onClick={() => {
              setPending(true);
              void onUnlink(link).finally(() => setPending(false));
            }}
          >
            {link.source === "stack" ? "Dismiss from thread" : "Unlink from thread"}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

export function ThreadPullRequestsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const configs = useServerConfigs();
  if (
    configs.get(threadRef.environmentId)?.environment.capabilities.threadPullRequestsV2 !== true
  ) {
    return (
      <PullRequestsUnavailableState
        title="Linked pull requests unavailable"
        error="This environment does not support multiple linked pull requests."
      />
    );
  }
  return <EnabledThreadPullRequestsPanel threadRef={threadRef} />;
}

function EnabledThreadPullRequestsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const projects = useProjects();
  // The thread's own project first, so a repository two projects share acts through this one.
  const environmentProjects = useMemo(
    () =>
      projects
        .filter((project) => project.environmentId === threadRef.environmentId)
        .toSorted((left, right) =>
          left.id === thread?.projectId ? -1 : right.id === thread?.projectId ? 1 : 0,
        ),
    [projects, threadRef.environmentId, thread?.projectId],
  );
  // Shift alone, and never while typing, like the Pull Requests page.
  const modifiers = useShortcutModifierState(true);
  const speedMode =
    modifiers.shiftKey && !modifiers.metaKey && !modifiers.ctrlKey && !modifiers.altKey;
  const openLinkDialog = useCallback(() => openLinkPullRequestDialog(threadRef), [threadRef]);
  const linking = usePullRequestLinking(threadRef.environmentId);
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });
  const capabilities = useServerConfigs().get(threadRef.environmentId)?.environment.capabilities;
  const supportsWatch = capabilities?.threadPullRequestWatch === true;
  const handleSetWatching = useCallback(
    (link: ThreadPullRequestLink, watching: boolean) => {
      void watch({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          host: link.host,
          repository: link.repository,
          number: link.number,
          watching,
        },
      });
    },
    [threadRef, watch],
  );
  const links = useMemo(() => visibleThreadPullRequests(thread?.pullRequests ?? []), [thread]);
  const lines = useMemo(() => pullRequestListLines(resolveThreadPullRequestChains(links)), [links]);
  const handleUnlink = async (link: ThreadPullRequestLink) => {
    if (!thread) return;
    try {
      await linking.unlink(threadRef, {
        projectId: link.projectId ?? thread.projectId,
        repository: link.repository,
        number: link.number,
        url: link.url,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not unlink pull request",
        description: String(error),
      });
    }
  };
  const openCount = useMemo(
    () => links.filter((link) => link.snapshot === null || link.snapshot.state === "open").length,
    [links],
  );
  const lastSynced = useMemo(() => {
    let latest: string | null = null;
    for (const link of links) {
      const at = link.snapshot?.syncedAt;
      if (at !== undefined && (latest === null || at > latest)) latest = at;
    }
    return latest;
  }, [links]);

  if (links.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <LinkIcon aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No linked pull requests</p>
        <p className="max-w-60 text-xs text-muted-foreground">
          Pull requests the agent opens from this thread land here. Link one yourself from a URL or
          a number.
        </p>
        <Button size="sm" variant="outline" onClick={openLinkDialog}>
          <PlusIcon className="size-3.5" />
          Link pull request
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        {/* Holding Shift shows each row's quick actions through this attribute, as on the
            Pull Requests page. */}
        <div
          className="group/pr-list flex flex-col p-1.5"
          data-speed-actions={speedMode ? "" : undefined}
        >
          {lines.map((line) => (
            <LinkRow
              key={`${line.link.host}/${line.link.repository}#${line.link.number}`}
              line={line}
              threadRef={threadRef}
              projectId={
                capabilities?.pullRequests === true
                  ? (findProjectForChangeRequest(environmentProjects, line.link)?.id ??
                    line.link.projectId ??
                    thread?.projectId ??
                    null)
                  : null
              }
              onUnlink={handleUnlink}
              onSetWatching={supportsWatch ? handleSetWatching : null}
            />
          ))}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
        <span>
          {openCount} open · {links.length} linked
          {lastSynced ? ` · synced ${formatRelativeTimeLabel(lastSynced)}` : ""}
        </span>
        <Button size="xs" variant="ghost" onClick={openLinkDialog} disabled={links.length >= 50}>
          <PlusIcon className="size-3.5" />
          Link
        </Button>
      </footer>
    </div>
  );
}
