import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, HermesWorkSetupState } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { hermesEnvironment } from "../state/hermes";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { HermesModelSetup } from "./HermesModelSetup";
import { Button } from "./ui/button";

export function HermesSetup({
  environmentId,
  providerInstanceId = "hermes",
  environmentLabel,
  compact = false,
  readOnly = false,
  onConnected,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId?: string;
  readonly environmentLabel?: string | undefined;
  readonly compact?: boolean;
  readonly readOnly?: boolean;
  readonly onConnected?: () => void;
}) {
  const target = { environmentId, input: { providerInstanceId } };
  const query = useEnvironmentQuery(hermesEnvironment.workSetupStatus(target));
  const start = useAtomCommand(hermesEnvironment.workSetupStart, { reportFailure: false });
  const [state, setState] = useState<HermesWorkSetupState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const notifiedRef = useRef(false);
  useEffect(() => {
    setState(query.data);
  }, [query.data]);
  const active =
    pending ||
    state?.phase === "installing" ||
    state?.phase === "configuring" ||
    state?.phase === "connecting";
  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") query.refresh();
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [active, query.refresh]);
  useEffect(() => {
    if (state?.phase !== "connected" || notifiedRef.current) return;
    notifiedRef.current = true;
    onConnected?.();
  }, [state?.phase, onConnected]);

  async function setup() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    notifiedRef.current = false;
    setPending(true);
    setError(null);
    try {
      const result = await start(target);
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Hermes setup failed. Try again.");
      } else {
        setState(result.value);
        query.refresh();
      }
    } catch {
      setError("Hermes setup lost its connection. Check the environment and try again.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-label="Hermes setup" className="grid gap-3 text-sm">
      {!compact ? (
        <p className="text-muted-foreground">
          Set up Hermes{environmentLabel ? ` on ${environmentLabel}` : ""}. T3 handles installation,
          connection, and startup.
        </p>
      ) : null}
      {state && state.phase !== "idle" ? (
        <p role="status" className="text-xs text-muted-foreground">
          {state.message}
        </p>
      ) : null}
      {state?.phase === "needs_model" ? (
        <HermesModelSetup
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          readOnly={readOnly}
          onReady={() => void setup()}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size={compact ? "xs" : "sm"}
          disabled={readOnly || active}
          onClick={() => void setup()}
        >
          {active
            ? "Setting up Hermes…"
            : state?.phase === "error"
              ? "Retry setup"
              : state?.phase === "connected" || state?.phase === "needs_model"
                ? "Check connection"
                : "Set up Hermes"}
        </Button>
      </div>
      {error || query.error ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? query.error}
        </p>
      ) : null}
    </section>
  );
}
