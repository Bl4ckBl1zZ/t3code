import { memo } from "react";
import { type PendingApproval } from "../../session-logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const approvalSummary =
    approval.requestKind === "mcp-elicitation"
      ? "App access approval requested"
      : approval.requestKind === "command"
        ? "Command approval requested"
        : approval.requestKind === "file-read"
          ? "File-read approval requested"
          : "File-change approval requested";
  const detailLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access request"
      : approval.requestKind === "command"
        ? "Command"
        : approval.requestKind === "file-read"
          ? "File to read"
          : "File change";

  return (
    <div className="min-w-0 px-3 py-2 sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      {approval.responseCapability === "not_resumable" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          This request belonged to a provider process that is no longer available. Interrupt or
          restart the run to continue.
        </p>
      ) : null}
      {approval.detail ? (
        <div className="mt-1.5 min-w-0 max-w-full">
          <pre
            tabIndex={0}
            aria-label={detailLabel}
            className="min-w-0 max-w-full max-h-20 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] leading-relaxed text-foreground/85 [scrollbar-width:thin] focus-visible:outline-ring"
            data-approval-detail="complete"
          >
            {approval.detail}
          </pre>
        </div>
      ) : null}
    </div>
  );
});
