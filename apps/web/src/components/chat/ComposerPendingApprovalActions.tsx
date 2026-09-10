import {
  type RuntimeRequestId,
  type ProviderApprovalOption,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import { memo } from "react";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  requestId: RuntimeRequestId;
  options?: readonly ProviderApprovalOption[] | undefined;
  isResponding: boolean;
  canRespond: boolean;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  options,
  isResponding,
  canRespond,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const choices =
    options ??
    ([
      { decision: "cancel", label: "Cancel turn" },
      { decision: "decline", label: "Decline" },
      { decision: "acceptForSession", label: "Always allow this session" },
      { decision: "accept", label: "Approve once" },
    ] satisfies readonly ProviderApprovalOption[]);
  return (
    <>
      {choices.map((option) => (
        <Button
          key={option.decision}
          size="micro"
          className="font-normal [@media(pointer:coarse)]:min-h-10"
          variant="ghost"
          disabled={isResponding || !canRespond}
          onClick={() => void onRespondToApproval(requestId, option.decision)}
        >
          {option.label}
        </Button>
      ))}
    </>
  );
});
