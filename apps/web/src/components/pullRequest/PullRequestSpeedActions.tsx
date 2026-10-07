import type { PullRequestAction } from "@t3tools/contracts";
import {
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import { useUiStateStore } from "~/uiStateStore";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { PullRequestActionPhase } from "./pullRequestActions.logic";
import { pullRequestSpeedActions, resolvePullRequestMergeMethod } from "./pullRequestDetail.logic";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import {
  readPullRequestDefaultMergeMethod,
  usePullRequestActionRunner,
} from "./usePullRequestActions";

/** What a row must know to act; list rows and linked pull requests both supply it. */
type PullRequestSpeedActionEntry = Pick<
  EnvironmentPullRequestEntry,
  | "environmentId"
  | "projectId"
  | "host"
  | "repository"
  | "number"
  | "state"
  | "isDraft"
  | "provider"
>;

export interface PullRequestSpeedActionResult<Entry = EnvironmentPullRequestEntry> {
  readonly entry: Entry;
  readonly action: PullRequestAction;
  readonly phase: PullRequestActionPhase;
}

const ACTIONS = {
  close: { label: "Close", Icon: GitPullRequestClosedIcon },
  merge: { label: "Merge", Icon: GitMergeIcon },
  ready: { label: "Ready for review", Icon: GitPullRequestIcon },
  reopen: { label: "Reopen", Icon: GitPullRequestArrowIcon },
} as const;

/**
 * The buttons a row shows while Shift is held. Shown by the list's own attribute rather than a
 * prop, so holding Shift re-renders no row; nothing is read from the host until one is pressed.
 */
export function PullRequestSpeedActions<Entry extends PullRequestSpeedActionEntry>({
  entry,
  onActed,
  closing = false,
  sweeping = false,
  onCloseSweepStart,
}: {
  entry: Entry;
  onActed?: (result: PullRequestSpeedActionResult<Entry>) => void;
  /** Closing as part of a swept batch. */
  closing?: boolean;
  /** Inside a close sweep that is still being dragged. */
  sweeping?: boolean;
  onCloseSweepStart?: (entry: Entry, event: PointerEvent) => void;
}) {
  const reference = {
    projectId: entry.projectId,
    ...(entry.host === undefined ? {} : { host: entry.host }),
    repository: entry.repository,
    number: entry.number,
  };
  const { pendingAction, perform } = usePullRequestActionRunner({
    environmentId: entry.environmentId,
    reference,
    onActed: (action, phase) => onActed?.({ entry, action, phase }),
    // The row knows too little to merge with: whether this viewer may, which methods the
    // repository allows, and whether the pull request sits in a stack all come from the host,
    // read when the merge's turn in the environment's queue comes.
    prepareMerge: {
      stackActions:
        appAtomRegistry.get(serverEnvironment.configValueAtom(entry.environmentId))?.environment
          .capabilities.pullRequestStackActions === true,
      resolveMergeMethod: (detail) => {
        const allowed = detail.capabilities.mergeMethods.filter(
          (method) => detail.mergeCapabilities[method],
        );
        if (allowed.length === 0) {
          throw new Error("No merge method is available for this repository.");
        }
        return resolvePullRequestMergeMethod(
          allowed,
          null,
          readPullRequestDefaultMergeMethod(entry.environmentId, entry.projectId),
          useUiStateStore.getState().pullRequestMergeMethod,
        );
      },
    },
  });
  const busy = pendingAction !== null || closing || sweeping;
  return (
    <div
      className={cn(
        "hidden shrink-0 items-center gap-1 pr-3 group-data-[speed-actions]/pr-list:flex",
        busy && "flex",
      )}
      role="group"
      aria-label={`Quick actions for pull request #${entry.number}`}
      data-pull-request-action-pending={pendingAction !== null || closing}
    >
      {pullRequestSpeedActions(entry).map((action) => {
        const { label, Icon } = ACTIONS[action];
        return (
          <Tooltip key={action}>
            <TooltipTrigger
              render={
                <Button
                  variant={action === "close" ? "destructive-outline" : "outline"}
                  size="xs"
                  disabled={busy}
                  aria-label={`${label} #${entry.number}`}
                  onClick={() => void perform(action)}
                  onPointerDown={(event) => {
                    if (action !== "close" || !event.isPrimary || event.button !== 0) return;
                    event.stopPropagation();
                    onCloseSweepStart?.(entry, event.nativeEvent);
                  }}
                />
              }
            >
              {pendingAction === action || (action === "close" && (closing || sweeping)) ? (
                <Spinner size="xs" />
              ) : (
                <Icon aria-hidden className="size-3" />
              )}
              {label}
            </TooltipTrigger>
            <TooltipPopup>
              {action === "close" && onCloseSweepStart
                ? "Close immediately, or drag across rows to close several"
                : `${label} immediately`}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
