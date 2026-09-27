import type {
  OrchestrationProjectShell,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShell,
  ProviderDriverKind,
} from "@t3tools/contracts";
import {
  BotIcon,
  CheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  FolderIcon,
  GitBranchIcon,
  TerminalIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { basenameOfPath } from "../../pierre-icons";
import { ThreadHoverCard } from "../ThreadHoverCard";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { SubagentWorkflowSummary } from "./SubagentWorkflowSummary";

const WORKING_STATUSES = new Set(["running", "in_progress", "pending", "waiting"]);
const FAILED_STATUSES = new Set(["failed", "error"]);
const SETTLED_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

/**
 * A subagent's hover card. Geometry and preview limits stay identical in the
 * lineage and timeline hovers, so both say the same thing about the same agent.
 */
export function SubagentTooltipContent(props: {
  readonly title: string;
  /** Display name of the model, already resolved against the provider. */
  readonly modelLabel: string | null;
  readonly driver?: ProviderDriverKind | undefined;
  readonly providerDisplayName?: string | undefined;
  readonly elapsed?: ReactNode;
  readonly parentThread?:
    | Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath">
    | undefined;
  readonly childThread?: Pick<OrchestrationV2ThreadShell, "branch" | "worktreePath"> | undefined;
  readonly parentProject?: Pick<OrchestrationProjectShell, "workspaceRoot"> | undefined;
  readonly childProject?:
    | Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot">
    | undefined;
  readonly status: string;
  readonly result?: string | null | undefined;
  readonly progress?: string | null | undefined;
  readonly workflow?: OrchestrationV2Subagent["workflow"];
  readonly usage?: OrchestrationV2Subagent["usage"];
}) {
  const currentWorkspace = props.parentThread?.worktreePath ?? props.parentProject?.workspaceRoot;
  const childWorkspace = props.childThread?.worktreePath ?? props.childProject?.workspaceRoot;
  const metadata = [
    ...(props.parentThread &&
    props.childProject &&
    props.childProject.id !== props.parentThread.projectId
      ? [{ label: "Project", value: props.childProject.title }]
      : []),
    ...(currentWorkspace && childWorkspace && currentWorkspace !== childWorkspace
      ? [
          {
            label: props.childThread?.branch
              ? "Branch"
              : props.childThread?.worktreePath
                ? "Worktree"
                : "Workspace",
            value: props.childThread?.branch ?? basenameOfPath(childWorkspace),
          },
        ]
      : []),
  ];
  // While it runs, live progress says more than a partial result; once it
  // stops, the result does.
  const result = props.result?.trim();
  const progress = props.progress?.trim();
  const detail =
    (SETTLED_STATUSES.has(props.status) ? result || progress : progress || result) ?? "";
  const compactDetail = detail.replace(/\s+/g, " ");
  const preview =
    compactDetail.length > 280 ? `${compactDetail.slice(0, 280).trimEnd()}…` : compactDetail;
  const working = WORKING_STATUSES.has(props.status);
  const failed = FAILED_STATUSES.has(props.status);
  const StatusIcon = failed
    ? CircleXIcon
    : props.status === "completed"
      ? CheckIcon
      : CircleDashedIcon;
  return (
    <ThreadHoverCard title={props.title}>
      <div className="flex min-w-0 items-center gap-2">
        {props.driver ? (
          <ProviderInstanceIcon
            driverKind={props.driver}
            displayName={props.providerDisplayName ?? props.driver}
            iconClassName="size-3 shrink-0 grayscale opacity-60"
          />
        ) : (
          <BotIcon className="size-3 shrink-0" />
        )}
        <span className="min-w-0 truncate text-foreground/75">
          {props.modelLabel ?? "Not reported"}
        </span>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-4">
        <span
          className={cn(
            "inline-flex items-center gap-1 font-medium capitalize",
            working
              ? "text-info"
              : failed
                ? "text-destructive"
                : props.status === "completed"
                  ? "text-success"
                  : "text-muted-foreground",
          )}
        >
          <StatusIcon aria-hidden className="size-3 shrink-0" />
          {props.status.replaceAll("_", " ")}
        </span>
        {props.elapsed}
      </div>
      {metadata.map(({ label, value }) => {
        const Icon = label === "Branch" ? GitBranchIcon : FolderIcon;
        return (
          <div key={label} className="flex min-w-0 items-center gap-2">
            <Icon aria-hidden className="size-3 shrink-0" />
            <span className="sr-only">{label}</span>
            <MiddleTruncate value={value} className="flex text-foreground/75" showTitle={false} />
          </div>
        );
      })}
      <SubagentWorkflowSummary workflow={props.workflow} usage={props.usage} />
      {preview ? (
        <div className="flex min-w-0 items-center gap-2">
          <TerminalIcon aria-hidden className="size-3 shrink-0" />
          <MiddleTruncate value={preview} className="flex text-foreground/75" showTitle={false} />
        </div>
      ) : null}
    </ThreadHoverCard>
  );
}
