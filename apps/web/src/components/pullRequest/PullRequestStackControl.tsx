import type {
  EnvironmentId,
  PullRequestDetail,
  PullRequestRef,
  PullRequestMergeMethod,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { LayersIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { useServerConfigs } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { PullRequestStackHeader } from "./PullRequestStackHeader";
import { PullRequestStackLayerContent } from "./PullRequestStackLayerContent";
import { reviewStackAction } from "./pullRequestStackReview";
import { toastManager } from "../ui/toast";

export function PullRequestStackControl({
  environmentId,
  reference,
  detail,
  threadRef,
  disabled,
  onActed,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetail;
  threadRef?: ScopedThreadRef;
  disabled: boolean;
  onActed: () => void;
}) {
  const configs = useServerConfigs();
  const supported =
    detail.provider === "github" &&
    configs.get(environmentId)?.environment.capabilities.pullRequestStackActions === true;
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<
    | (NonNullable<ReturnType<typeof reviewStackAction>> & {
        mergeMethods: readonly PullRequestMergeMethod[];
      })
    | null
  >(null);
  const query = useEnvironmentQuery(
    supported && (open || review !== null)
      ? pullRequestEnvironment.stack({ environmentId, input: reference })
      : null,
  );
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const openLink = useOpenPrLink(threadRef);
  const [method, setMethod] = useState<PullRequestMergeMethod>("merge");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!supported) return null;
  const stack = query.data;
  const fresh = stack !== null && !query.isPending && !query.error;
  const mergeMethods = detail.capabilities.mergeMethods.filter(
    (method) => detail.mergeCapabilities[method],
  );
  const canMerge =
    !disabled &&
    fresh &&
    detail.viewerPermissions.actions.includes("merge") &&
    mergeMethods.length > 0;
  const canRebase =
    !disabled &&
    fresh &&
    detail.viewerPermissions.stackRebase === true &&
    detail.capabilities.updateMethods?.includes("rebase") === true;

  const arm = (action: "merge" | "update-branch") => {
    if (!stack || !(action === "merge" ? canMerge : canRebase)) return;
    const candidate = reviewStackAction(
      stack,
      action === "merge" ? reference.number : stack.layers.at(-1)!.number,
      action,
    );
    if (!candidate) return;
    setReview({ ...candidate, mergeMethods: [...mergeMethods] });
    setMethod(mergeMethods[0] ?? "merge");
    setError(null);
  };
  const close = () => {
    if (!pending) {
      setReview(null);
      query.refresh();
      onActed();
    }
  };
  const perform = async () => {
    if (
      !review ||
      disabled ||
      pending ||
      error ||
      (review.action === "merge" && !review.mergeMethods.includes(method))
    )
      return;
    setPending(true);
    const result = await runAction({
      environmentId,
      input: {
        ...reference,
        number: review.number,
        action: review.action,
        stackNumber: review.stackNumber,
        expectedStackHeads: review.heads,
        ...(review.action === "merge"
          ? { mergeMethod: method }
          : { updateMethod: "rebase" as const }),
      },
    });
    setPending(false);
    query.refresh();
    onActed();
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else {
      setReview(null);
      toastManager.add({
        type: "success",
        title: review.action === "merge" ? "Stack merge completed" : "Stack rebased",
      });
    }
  };
  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger render={<Button variant="ghost" size="xs" disabled={disabled || pending} />}>
          <LayersIcon className="size-3.5" />
          Stack
        </MenuTrigger>
        <MenuPopup align="end" className="w-80 max-w-[calc(100vw-2rem)]">
          {stack ? (
            <>
              <PullRequestStackHeader
                number={stack.number}
                notice={query.error ?? (query.isPending ? "Refreshing…" : null)}
                stale={!!query.error}
              />
              <div className="max-h-72 overflow-y-auto">
                {stack.layers.toReversed().map((layer) => {
                  const url = new URL(detail.url);
                  url.pathname = url.pathname.replace(/\/pull\/\d+.*/, `/pull/${layer.number}`);
                  url.search = "";
                  url.hash = "";
                  return (
                    <MenuItem
                      key={layer.number}
                      render={
                        <a
                          href={url.toString()}
                          onClick={(event) => openLink(event, url.toString())}
                        />
                      }
                      aria-current={layer.number === reference.number ? "true" : undefined}
                    >
                      <PullRequestStackLayerContent layer={layer} />
                    </MenuItem>
                  );
                })}
              </div>
              <MenuSeparator />
              <MenuItem
                disabled={!canMerge || !reviewStackAction(stack, reference.number, "merge")}
                onClick={() => arm("merge")}
              >
                Merge through #{reference.number}
              </MenuItem>
              <MenuItem
                disabled={
                  !canRebase ||
                  !reviewStackAction(stack, stack.layers.at(-1)?.number ?? 0, "update-branch")
                }
                onClick={() => arm("update-branch")}
              >
                Rebase stack
              </MenuItem>
            </>
          ) : (
            <p role="status" className="p-3 text-xs text-muted-foreground">
              {query.error ??
                (query.isPending
                  ? "Loading stack…"
                  : "This pull request does not belong to a GitHub stack.")}
            </p>
          )}
          <MenuItem onClick={query.refresh}>
            <RefreshCwIcon className="size-3.5" />
            Refresh stack
          </MenuItem>
        </MenuPopup>
      </Menu>
      <Dialog
        open={review !== null}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogPopup showCloseButton={!pending} className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {review?.action === "merge" ? `Merge through #${review.number}` : "Rebase stack"}
            </DialogTitle>
            <DialogDescription>
              Review the affected revisions. This updates remote branches on GitHub. Earlier
              completed updates remain if a later layer fails.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ul className="max-h-64 space-y-2 overflow-y-auto">
              {review?.layers.map((layer) => (
                <li
                  key={layer.number}
                  className="flex items-center gap-2 rounded-md bg-muted/50 p-2"
                >
                  <PullRequestStackLayerContent layer={layer} compact />
                  <code className="text-xs">{layer.headSha?.slice(0, 8)}</code>
                </li>
              ))}
            </ul>
            {review?.action === "merge" ? (
              <label className="mt-3 flex items-center justify-between text-sm">
                Merge strategy
                <select
                  className="rounded-md border bg-background p-2"
                  value={method}
                  disabled={pending}
                  onChange={(event) => setMethod(event.target.value as PullRequestMergeMethod)}
                >
                  {review.mergeMethods.map((method) => (
                    <option key={method} value={method}>
                      {method}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {error ? (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {error} Close to refresh before retrying.
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={close}>
              Close
            </Button>
            <Button disabled={pending || !!error || !review} onClick={() => void perform()}>
              {pending ? "Working…" : "Confirm reviewed layers"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
