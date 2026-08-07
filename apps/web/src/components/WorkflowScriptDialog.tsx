/**
 * Read-only viewer for a workflow's script, opened from the Agents surface.
 *
 * The path is a hint carried on the task's run handles; the server re-derives
 * and re-validates containment before reading, so nothing here is trusted to
 * be safe just because it arrived from a projection.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { orchestrationEnvironment } from "~/state/orchestration";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

/**
 * Every failure reason the server can return, phrased for a person. The
 * containment rejections are deliberately blunt: if one of them appears, the
 * path did not come from where it claimed to, and that is worth saying rather
 * than smoothing over as "could not load".
 */
const FAILURE_COPY: Record<string, string> = {
  "invalid-path": "That script path is not a valid absolute .js path.",
  "root-unavailable": "The workflow script directory is not available on this machine.",
  "not-found": "This script no longer exists — its run was probably cleaned up.",
  "outside-root": "Refused: that path resolves outside the workflow script directory.",
  "not-js": "Refused: that path does not resolve to a .js file.",
  "not-regular-file": "Refused: that path is not a regular file.",
  "changed-during-read": "The file changed while it was being read. Try again.",
  "read-failed": "The script could not be read.",
};

export function WorkflowScriptDialog({
  threadRef,
  scriptPath,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  scriptPath: string | null;
  onClose: () => void;
}) {
  const getWorkflowScript = useAtomCommand(orchestrationEnvironment.v2.getWorkflowScript, {
    reportFailure: false,
  });
  const [contents, setContents] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (scriptPath === null) return;
    let cancelled = false;
    setContents(null);
    setError(null);
    setTruncated(false);
    setResolvedPath(null);
    void (async () => {
      const result = await getWorkflowScript({
        environmentId: threadRef.environmentId,
        input: { scriptPath },
      });
      if (cancelled) return;
      if (result._tag === "Success") {
        setContents(result.value.contents);
        setTruncated(result.value.truncated);
        setResolvedPath(result.value.scriptPath);
        return;
      }
      // An interrupted command is a superseded request, not a failure to
      // report: the dialog either closed or is already loading a newer path.
      if (isAtomCommandInterrupted(result)) return;
      const failure: unknown = squashAtomCommandFailure(result);
      const reason =
        typeof failure === "object" && failure !== null && "reason" in failure
          ? String((failure as { reason: unknown }).reason)
          : "read-failed";
      setError(FAILURE_COPY[reason] ?? "The script could not be read.");
    })();
    return () => {
      cancelled = true;
    };
  }, [scriptPath, threadRef.environmentId, getWorkflowScript]);

  return (
    <Dialog open={scriptPath !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Workflow script</DialogTitle>
          <DialogDescription className="truncate font-mono text-[11px]">
            {resolvedPath ?? scriptPath ?? ""}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error !== null ? (
            <p className="text-xs text-destructive-foreground">{error}</p>
          ) : contents === null ? (
            <p className="text-xs text-muted-foreground/70">Loading…</p>
          ) : (
            <>
              {truncated ? (
                <p className="mb-2 text-[11px] text-muted-foreground/70">
                  Showing the first 256 KB of a larger file.
                </p>
              ) : null}
              <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted/40 p-3 text-[11px] leading-relaxed">
                <code>{contents}</code>
              </pre>
            </>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
