import type {
  EnvironmentId,
  ProviderConsumeResetCreditInput,
  ProviderConsumeResetCreditOutcome,
  ServerProviderResetCredits,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "../ui/alert-dialog";
import { formatDuration } from "./usageLimits.logic";

const outcomeText: Record<ProviderConsumeResetCreditOutcome, string> = {
  reset: "Reset applied. Your windows have cleared.",
  nothingToReset: "Nothing to reset right now.",
  noCredit: "No reset credit left.",
  alreadyRedeemed: "That credit was already redeemed.",
};

export function ResetCredits({
  target,
  credits,
  now,
  canOperate,
}: {
  target: { environmentId: EnvironmentId } & ProviderConsumeResetCreditInput;
  credits: ServerProviderResetCredits;
  now: number;
  canOperate: boolean;
}) {
  const consume = useAtomCommand(serverEnvironment.consumeResetCredit, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [status, setStatus] = useState<string | null>(null);
  const redeem = async () => {
    if (inFlight.current || !canOperate || credits.availableCount <= 0) return;
    inFlight.current = true;
    setBusy(true);
    setConfirming(false);
    setStatus(null);
    try {
      const result = await consume({
        environmentId: target.environmentId,
        input:
          "instanceId" in target
            ? { instanceId: target.instanceId }
            : { sourceId: target.sourceId, accountId: target.accountId, creditId: target.creditId },
      });
      setStatus(
        result._tag === "Success"
          ? (result.value.warning ?? outcomeText[result.value.outcome])
          : "error" in result.cause && result.cause.error instanceof Error
            ? result.cause.error.message
            : "Could not use the reset credit.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  if (credits.availableCount === 0 && status === null) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>
        {credits.availableCount} {credits.availableCount === 1 ? "reset credit" : "reset credits"}{" "}
        banked
        {credits.nextExpiresAt
          ? ` · next expires in ${formatDuration(Date.parse(credits.nextExpiresAt) - now)}`
          : ""}
      </span>
      <Button
        size="xs"
        variant="outline"
        disabled={busy || !canOperate || credits.availableCount === 0}
        onClick={() => setConfirming(true)}
      >
        {busy && <Spinner className="size-3" />} {busy ? "Using…" : "Use reset"}
      </Button>
      {status && (
        <span role="status" className="basis-full text-foreground">
          {status}
        </span>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Use a reset credit?</AlertDialogTitle>
            <AlertDialogDescription>
              This redeems one credit on your account and clears the current rate-limit windows. It
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button disabled={busy || !canOperate} onClick={() => void redeem()}>
              Use credit
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
