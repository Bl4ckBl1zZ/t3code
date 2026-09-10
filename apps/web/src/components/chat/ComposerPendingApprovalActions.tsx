import { type RuntimeRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { memo } from "react";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  canRespond,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  return (
    <>
      <Button
        size="micro"
        className="font-normal [@media(pointer:coarse)]:min-h-10"
        variant="ghost"
        disabled={isResponding || !canRespond}
        onClick={() => void onRespondToApproval(requestId, "cancel")}
      >
        Cancel turn
      </Button>
      <Button
        size="micro"
        className="font-normal [@media(pointer:coarse)]:min-h-10"
        variant="ghost"
        disabled={isResponding || !canRespond}
        onClick={() => void onRespondToApproval(requestId, "decline")}
      >
        Decline
      </Button>
      <Button
        size="micro"
        className="font-normal [@media(pointer:coarse)]:min-h-10"
        variant="ghost"
        disabled={isResponding || !canRespond}
        onClick={() => void onRespondToApproval(requestId, "acceptForSession")}
      >
        Always allow this session
      </Button>
      <Button
        size="micro"
        className="font-normal [@media(pointer:coarse)]:min-h-10"
        variant="ghost"
        disabled={isResponding || !canRespond}
        onClick={() => void onRespondToApproval(requestId, "accept")}
      >
        Approve once
      </Button>
    </>
  );
});
