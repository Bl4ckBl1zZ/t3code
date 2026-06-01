import type { ReviewPullRequestComment } from "@t3tools/contracts";
import { MessageSquareTextIcon, PanelLeftCloseIcon, RefreshCwIcon } from "lucide-react";

import { formatWorkspaceRelativePath } from "~/filePathDisplay";
import { cn } from "~/lib/utils";
import { pullRequestCommentTitle } from "~/pullRequestReviewComments";
import { ScrollArea } from "./ui/scroll-area";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

interface PullRequestUnreadCommentsSidePanelProps {
  readonly comments: ReadonlyArray<ReviewPullRequestComment>;
  readonly pullRequestNumber: number;
  readonly pullRequestTitle: string;
  readonly workspaceRoot: string | undefined;
  readonly isFetching: boolean;
  readonly error: unknown;
  readonly onAddAll: () => void;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
  readonly mode?: "sidebar" | "sheet";
}

function commentLocation(comment: ReviewPullRequestComment, workspaceRoot: string | undefined) {
  if (!comment.filePath) {
    return "Conversation";
  }
  const path = formatWorkspaceRelativePath(comment.filePath, workspaceRoot);
  if (comment.startLine !== null && comment.line !== null && comment.startLine !== comment.line) {
    return `${path}:${comment.startLine}-${comment.line}`;
  }
  if (comment.line !== null) {
    return `${path}:${comment.line}`;
  }
  return path;
}

function errorMessage(error: unknown): string | null {
  if (!error) {
    return null;
  }
  return error instanceof Error ? error.message : "Failed to load pull request comments.";
}

function PullRequestCommentCard({
  comment,
  workspaceRoot,
}: {
  readonly comment: ReviewPullRequestComment;
  readonly workspaceRoot: string | undefined;
}) {
  const title = pullRequestCommentTitle(comment);

  return (
    <div
      className={cn(
        "rounded-md border border-border/60 bg-background/70 p-2",
        comment.kind === "inline" ? "border-l-primary/50" : null,
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="truncate text-xs font-medium">
          {comment.authorLogin ? `@${comment.authorLogin}` : "Unknown author"}
        </div>
        <div className="shrink-0 truncate text-muted-foreground text-[11px]">
          {commentLocation(comment, workspaceRoot)}
        </div>
      </div>
      <div className="mt-1 line-clamp-2 text-xs font-medium leading-relaxed" title={title}>
        {title}
      </div>
    </div>
  );
}

export function PullRequestUnreadCommentsSidePanel({
  comments,
  pullRequestNumber,
  pullRequestTitle,
  workspaceRoot,
  isFetching,
  error,
  onAddAll,
  onRefresh,
  onClose,
  mode = "sidebar",
}: PullRequestUnreadCommentsSidePanelProps) {
  const message = errorMessage(error);
  const commentCountLabel = `${comments.length} unread ${
    comments.length === 1 ? "comment" : "comments"
  }`;

  return (
    <aside
      aria-label="Pull request comments"
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar"
          ? "h-full w-[340px] shrink-0 border-r border-border/70"
          : "h-full w-full",
      )}
    >
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquareTextIcon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">PR comments</div>
            <div className="truncate text-xs text-muted-foreground">
              #{pullRequestNumber} {pullRequestTitle}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh PR comments"
            onClick={onRefresh}
            disabled={isFetching}
          >
            {isFetching ? <Spinner className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Close PR comments panel"
            onClick={onClose}
          >
            <PanelLeftCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3">
        <div className="min-w-0 truncate text-muted-foreground text-xs">{commentCountLabel}</div>
        <Button type="button" size="xs" onClick={onAddAll} disabled={comments.length === 0}>
          Add all
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          {message ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-destructive text-xs"
            >
              {message}
            </div>
          ) : null}

          {comments.length > 0 ? (
            <div className="space-y-2">
              {comments.map((comment) => (
                <PullRequestCommentCard
                  key={comment.id}
                  comment={comment}
                  workspaceRoot={workspaceRoot}
                />
              ))}
            </div>
          ) : (
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/70 px-4 py-8 text-center">
              {isFetching ? <Spinner className="size-4 text-muted-foreground" /> : null}
              <div className="text-sm font-medium">
                {isFetching ? "Loading PR comments" : "No unread PR comments"}
              </div>
              <div className="max-w-60 text-muted-foreground text-xs">
                {isFetching
                  ? "Fetching the latest review comments from GitHub."
                  : "New review comments for this pull request will appear here."}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
