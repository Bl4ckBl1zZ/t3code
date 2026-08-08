import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

const MAX_FILE_ROWS = 6;

export interface CheckpointRestoreFacts {
  readonly capturedAtLabel?: string | undefined;
  readonly files?:
    | ReadonlyArray<{
        readonly path: string;
        readonly additions?: number | undefined;
        readonly deletions?: number | undefined;
      }>
    | undefined;
  readonly exchangesAfter?: number | undefined;
  readonly newerRestorePoints?: number | undefined;
}

interface CheckpointRestoreDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => Promise<void> | void;
  readonly facts: CheckpointRestoreFacts;
}

export function CheckpointRestoreDialog({
  open,
  onOpenChange,
  onConfirm,
  facts,
}: CheckpointRestoreDialogProps) {
  const [isRestoring, setIsRestoring] = useState(false);
  useEffect(() => {
    if (!open) setIsRestoring(false);
  }, [open]);

  const files = facts.files;
  const visibleFiles = files?.slice(0, MAX_FILE_ROWS) ?? [];
  const overflowCount = files ? files.length - visibleFiles.length : 0;
  const exchangesAfter = facts.exchangesAfter;
  const newerRestorePoints = facts.newerRestorePoints;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {facts.capturedAtLabel
              ? `Restore to ${facts.capturedAtLabel}?`
              : "Restore to this point?"}
          </AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="space-y-3 text-left">
            {files === undefined ? (
              <p>Workspace files return to their state at this point.</p>
            ) : (
              <div className="space-y-1.5">
                <p>
                  <span className="font-semibold text-foreground">
                    {files.length} {files.length === 1 ? "file" : "files"}
                  </span>{" "}
                  return{files.length === 1 ? "s" : ""} to {files.length === 1 ? "its" : "their"}{" "}
                  earlier state
                </p>
                {visibleFiles.length > 0 ? (
                  <ul className="space-y-0.5 rounded-md border border-border/45 p-2">
                    {visibleFiles.map((file) => (
                      <li key={file.path} className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate font-mono text-[11px] text-foreground/80">
                          {file.path}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] tabular-nums">
                          {file.additions !== undefined ? (
                            <span className="text-green-600 dark:text-green-500">
                              +{file.additions}
                            </span>
                          ) : null}{" "}
                          {file.deletions !== undefined ? (
                            <span className="text-red-600 dark:text-red-500">
                              −{file.deletions}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                    {overflowCount > 0 ? (
                      <li className="text-[11px] text-muted-foreground">
                        …and {overflowCount} more
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </div>
            )}
            {exchangesAfter === undefined ? null : exchangesAfter > 0 ? (
              <p>
                <span className="font-semibold text-foreground">
                  {exchangesAfter} {exchangesAfter === 1 ? "exchange" : "exchanges"}
                </span>{" "}
                after this point {exchangesAfter === 1 ? "is" : "are"} deleted
              </p>
            ) : (
              <p>No messages after this point are deleted.</p>
            )}
            {newerRestorePoints !== undefined && newerRestorePoints > 0 ? (
              <p className="text-amber-600 dark:text-amber-500">
                {newerRestorePoints} newer restore{" "}
                {newerRestorePoints === 1 ? "point becomes" : "points become"} unusable
              </p>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />} disabled={isRestoring}>
            Cancel
          </AlertDialogClose>
          <Button
            variant="destructive"
            disabled={isRestoring}
            onClick={() => {
              setIsRestoring(true);
              void Promise.resolve(onConfirm()).finally(() => setIsRestoring(false));
            }}
          >
            {isRestoring ? "Restoring…" : "Restore to this point"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
