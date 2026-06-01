import type { ReviewPullRequestComment } from "@t3tools/contracts";
import { MessageSquareTextIcon, RefreshCwIcon } from "lucide-react";

import { formatWorkspaceRelativePath } from "~/filePathDisplay";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

interface PullRequestUnreadCommentsPanelProps {
  readonly comments: ReadonlyArray<ReviewPullRequestComment>;
  readonly pullRequestNumber: number;
  readonly pullRequestTitle: string;
  readonly workspaceRoot: string | undefined;
  readonly isFetching: boolean;
  readonly error: unknown;
  readonly onAddAll: () => void;
  readonly onRefresh: () => void;
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

export function PullRequestUnreadCommentsPanel({
  comments,
  pullRequestNumber,
  pullRequestTitle,
  workspaceRoot,
  isFetching,
  error,
  onAddAll,
  onRefresh,
}: PullRequestUnreadCommentsPanelProps) {
  if (comments.length === 0 && !isFetching && !error) {
    return null;
  }

  const message = errorMessage(error);

  return (
    <div className="mx-auto mb-2 max-w-208 rounded-lg border border-border/70 bg-card p-3 shadow-sm">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <MessageSquareTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {comments.length} unread PR {comments.length === 1 ? "comment" : "comments"}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              #{pullRequestNumber} {pullRequestTitle}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
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
          <Button type="button" size="xs" onClick={onAddAll} disabled={comments.length === 0}>
            Add all
          </Button>
        </div>
      </div>

      {message ? <div className="mt-2 text-destructive text-xs">{message}</div> : null}

      {comments.length > 0 ? (
        <div className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
          {comments.map((comment) => (
            <div
              key={comment.id}
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
              <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-muted-foreground text-xs">
                {comment.body.trim() || "(empty comment)"}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
