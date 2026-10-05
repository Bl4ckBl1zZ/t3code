import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { PullRequestAction } from "@t3tools/contracts";
import {
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
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

export interface PullRequestSpeedActionResult {
  readonly entry: EnvironmentPullRequestEntry;
  readonly action: PullRequestAction;
  readonly phase: PullRequestActionPhase;
}

const ACTIONS = {
  close: { label: "Close", Icon: GitPullRequestClosedIcon },
  merge: { label: "Merge", Icon: GitMergeIcon },
  ready: { label: "Ready for review", Icon: GitPullRequestIcon },
  reopen: { label: "Reopen", Icon: GitPullRequestArrowIcon },
} as const;

async function settle<A>(result: Promise<AtomCommandResult<A, unknown>>): Promise<A> {
  const settled = await result;
  if (settled._tag === "Failure") throw squashAtomCommandFailure(settled);
  return settled.value;
}

/**
 * The buttons a row shows while Shift is held. Shown by the list's own attribute rather than a
 * prop, so holding Shift re-renders no row; nothing is read from the host until one is pressed.
 */
export function PullRequestSpeedActions({
  entry,
  onActed,
}: {
  entry: EnvironmentPullRequestEntry;
  onActed: (result: PullRequestSpeedActionResult) => void;
}) {
  const readDetail = useAtomCommand(pullRequestEnvironment.readDetail, { reportFailure: false });
  const readStack = useAtomCommand(pullRequestEnvironment.readStack, { reportFailure: false });
  const reference = {
    projectId: entry.projectId,
    ...(entry.host === undefined ? {} : { host: entry.host }),
    repository: entry.repository,
    number: entry.number,
  };
  const { pendingAction, perform } = usePullRequestActionRunner({
    environmentId: entry.environmentId,
    reference,
    onActed: (action, phase) => onActed({ entry, action, phase }),
    // The row knows too little to merge with: whether this viewer may, which methods the
    // repository allows, and whether the pull request sits in a stack all come from the host.
    resolveMergeMethod: async () => {
      const target = { environmentId: entry.environmentId, input: reference };
      const detail = await settle(readDetail(target));
      if (
        detail.state !== "open" ||
        detail.isDraft ||
        !detail.capabilities.actions.includes("merge") ||
        !detail.viewerPermissions.actions.includes("merge")
      ) {
        throw new Error("This pull request cannot be merged.");
      }
      const capabilities = appAtomRegistry.get(
        serverEnvironment.configValueAtom(entry.environmentId),
      )?.environment.capabilities;
      if (detail.provider === "github" && capabilities?.pullRequestStackActions === true) {
        const stack = await settle(readStack(target));
        if (stack !== null) throw new Error("Open this pull request to merge its stack.");
      }
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
  });
  return (
    <div
      className={cn(
        "hidden shrink-0 items-center gap-1 pr-3 group-data-[speed-actions]/pr-list:flex",
        pendingAction !== null && "flex",
      )}
      role="group"
      aria-label={`Quick actions for pull request #${entry.number}`}
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
                  disabled={pendingAction !== null}
                  aria-label={`${label} #${entry.number}`}
                  onClick={() => void perform(action)}
                />
              }
            >
              {pendingAction === action ? (
                <Spinner size="xs" />
              ) : (
                <Icon aria-hidden className="size-3" />
              )}
              {label}
            </TooltipTrigger>
            <TooltipPopup>{`${label} immediately`}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
