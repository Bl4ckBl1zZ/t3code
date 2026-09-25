import type { DesktopSnapShotSetupAction, DesktopSnapShotState } from "@t3tools/contracts";
import { CircleCheckIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { MacAccessibilityIcon, MacScreenRecordingIcon } from "../Icons";
import { Button } from "../ui/button";
import { Dialog, DialogDescription } from "../ui/dialog";
import { WizardSteps, WizardPopup, WizardHeader, WizardPanel, WizardFooter } from "../ui/wizard";
import {
  captureSetupMacPermissionsReady,
  type CaptureSetupStep,
} from "./SnapShotSetupDialog.logic";

function MacPermissionRow({
  icon,
  title,
  description,
  granted,
  busy,
  onAllow,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  granted: boolean;
  busy: boolean;
  onAllow: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
      {icon}
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {granted ? (
        <span className="flex items-center gap-1 text-xs text-success">
          <CircleCheckIcon className="size-4" aria-hidden="true" />
          Allowed
        </span>
      ) : (
        <Button size="xs" variant="outline" disabled={busy} onClick={onAllow}>
          Allow
        </Button>
      )}
    </div>
  );
}

export function SnapShotSetupDialog({
  state,
  initialStep,
  includeAccessibility,
  busy,
  error,
  shortcutInput,
  shortcutStatus,
  shortcutChanged,
  canSaveShortcut,
  onSaveShortcut,
  onEnable,
  onAction,
  onRefresh,
  onClose,
  onLeaveStep,
}: {
  state: DesktopSnapShotState;
  initialStep: CaptureSetupStep;
  wasEnabled: boolean;
  includeAccessibility: boolean;
  busy: boolean;
  error: string | null;
  shortcutInput: ReactNode;
  shortcutStatus: string | null | undefined;
  shortcutChanged: boolean;
  canSaveShortcut: boolean;
  onSaveShortcut: () => Promise<boolean>;
  onEnable: () => Promise<boolean>;
  onAction: (action: DesktopSnapShotSetupAction) => Promise<void>;
  onRefresh: () => Promise<DesktopSnapShotState | undefined>;
  onClose: (completed: boolean) => Promise<void>;
  onLeaveStep: () => void;
}) {
  const [step, setStep] = useState(initialStep);
  const ready = captureSetupMacPermissionsReady(state, includeAccessibility);
  useEffect(() => {
    const refresh = () => void onRefresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [onRefresh]);
  const changeStep = (next: CaptureSetupStep) => {
    onLeaveStep();
    setStep(next);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) void onClose(false);
      }}
    >
      <WizardPopup showCloseButton={!busy}>
        <WizardHeader title="Set up snapshots">
          <WizardSteps
            steps={["Access", "Shortcut"]}
            currentStep={step === "access" ? 0 : 1}
            isStepDisabled={(index) => busy || (index === 1 && step === "access")}
            onStepChange={(index) => changeStep(index === 0 ? "access" : "shortcut")}
          />
        </WizardHeader>
        <WizardPanel>
          <div className="space-y-4 text-sm">
            <h3 className="font-medium">
              {step === "access" ? "Allow snapshots" : "Choose your shortcut"}
            </h3>
            <DialogDescription>
              {step === "access"
                ? ready
                  ? "Test a snapshot of the current window. If macOS asks to bypass its window picker, choose Allow. The test image is discarded."
                  : "Allow each permission, then continue. macOS may ask you to restart T3 Code; setup will resume here."
                : "Use both Shift keys, or record a different shortcut. Capture the window you are using without switching apps."}
            </DialogDescription>
            {step === "access" ? (
              <div className="space-y-2">
                <MacPermissionRow
                  icon={<MacScreenRecordingIcon className="size-8 shrink-0 drop-shadow-sm" />}
                  title="Screen Recording"
                  description="Capture the current window."
                  granted={state.macPermissions?.screenRecording === true}
                  busy={busy}
                  onAllow={() => void onAction("allow-screen-recording")}
                />
                <MacPermissionRow
                  icon={<MacAccessibilityIcon className="size-8 shrink-0 drop-shadow-sm" />}
                  title="Accessibility"
                  description={
                    includeAccessibility
                      ? "Include text and controls from the captured app."
                      : "Observe modifier-pair shortcuts. App text stays off."
                  }
                  granted={state.macPermissions?.accessibility === true}
                  busy={busy}
                  onAllow={() => void onAction("allow-accessibility")}
                />
                <Button variant="ghost" disabled={busy} onClick={() => void onRefresh()}>
                  Check again
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {shortcutInput}
                {shortcutStatus && (
                  <p role="status" className="text-xs text-muted-foreground">
                    {shortcutStatus}
                  </p>
                )}
                {!state.shortcutRegistered && !shortcutChanged && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void onAction("retry-shortcut")}
                  >
                    Try again
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">
                  Your capture is added to a draft. Review it before sending.
                </p>
              </div>
            )}
            {(error || state.message) && (
              <p role="alert" className="text-destructive">
                {error ?? state.message}
              </p>
            )}
          </div>
        </WizardPanel>
        <WizardFooter
          leading={
            <Button variant="ghost" disabled={busy} onClick={() => void onClose(false)}>
              Finish later
            </Button>
          }
        >
          {step === "access" ? (
            <Button
              disabled={busy || !ready}
              onClick={async () => {
                if (await onEnable()) changeStep("shortcut");
              }}
            >
              {busy ? "Working…" : "Test capture and continue"}
            </Button>
          ) : (
            <Button
              disabled={
                busy || !ready || (shortcutChanged ? !canSaveShortcut : !state.shortcutRegistered)
              }
              onClick={async () => {
                if (!shortcutChanged || (await onSaveShortcut())) await onClose(true);
              }}
            >
              {busy ? "Saving…" : shortcutChanged ? "Save and finish" : "Done"}
            </Button>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
