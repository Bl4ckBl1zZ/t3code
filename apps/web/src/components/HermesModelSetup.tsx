import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, HermesWorkModelAuthStartResult } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { ensureLocalApi } from "../localApi";
import { hermesEnvironment } from "../state/hermes";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";

export function HermesModelSetup({
  environmentId,
  providerInstanceId,
  onReady,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: string;
  readonly onReady: () => void;
  readonly readOnly: boolean;
}) {
  const target = { environmentId, input: { providerInstanceId } };
  const status = useEnvironmentQuery(hermesEnvironment.workModelStatus(target));
  const startAuth = useAtomCommand(hermesEnvironment.workModelAuthStart, { reportFailure: false });
  const cancelAuth = useAtomCommand(hermesEnvironment.workModelAuthCancel, {
    reportFailure: false,
  });
  const setModel = useAtomCommand(hermesEnvironment.workModelSet, { reportFailure: false });
  const [flow, setFlow] = useState<
    (HermesWorkModelAuthStartResult & { provider: string; expiresAt: number }) | null
  >(null);
  const [providerId, setProviderId] = useState("");
  const [model, selectModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const completedRef = useRef(false);
  const poll = useEnvironmentQuery(
    flow
      ? hermesEnvironment.workModelAuthPoll({
          environmentId,
          input: { providerInstanceId, provider: flow.provider, sessionId: flow.sessionId },
        })
      : null,
  );
  const providers = status.data?.providers.filter((provider) => provider.authenticated) ?? [];
  const selectedProvider = providers.find((provider) => provider.id === providerId) ?? providers[0];
  const selectedModel = selectedProvider?.models.includes(model)
    ? model
    : (selectedProvider?.models[0] ?? "");

  useEffect(() => {
    if (!flow) return;
    const timer = window.setInterval(
      () => {
        if (Date.now() >= flow.expiresAt) {
          setFlow(null);
          setError("Sign-in expired. Try again.");
        } else if (document.visibilityState === "visible") poll.refresh();
      },
      Math.max(1, flow.pollInterval) * 1_000,
    );
    return () => window.clearInterval(timer);
  }, [flow, poll.refresh]);
  useEffect(() => {
    if (!flow || !poll.data || poll.data.status === "pending") return;
    if (poll.data.status === "approved") {
      setError(null);
      status.refresh();
    } else setError(poll.data.message ?? "Sign-in did not complete. Try again.");
    setFlow(null);
  }, [flow, poll.data, status.refresh]);
  useEffect(() => {
    if (!status.data?.ready || completedRef.current) return;
    completedRef.current = true;
    onReady();
  }, [status.data?.ready, onReady]);

  async function signIn(provider: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await startAuth({ environmentId, input: { providerInstanceId, provider } });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not start sign-in.");
      } else {
        setFlow({
          ...result.value,
          provider,
          expiresAt: Date.now() + result.value.expiresIn * 1_000,
        });
      }
    } finally {
      setBusy(false);
    }
  }
  async function saveModel(confirmExpensiveModel = false) {
    if (!selectedProvider || !selectedModel) return;
    setBusy(true);
    setError(null);
    try {
      const result = await setModel({
        environmentId,
        input: {
          providerInstanceId,
          provider: selectedProvider.id,
          model: selectedModel,
          confirmExpensiveModel,
        },
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not select the model.");
      } else if (result.value.confirmRequired)
        setConfirmation(result.value.message ?? "Use this model?");
      else if (result.value.ok) {
        setConfirmation(null);
        onReady();
      } else setError(result.value.message ?? "Could not select the model.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-3 rounded-lg border border-border p-3 text-sm">
      <p className="font-medium">Connect a model account</p>
      {flow ? (
        <>
          <p>
            Enter this code on the sign-in page:{" "}
            <code className="select-all font-semibold">{flow.userCode}</code>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => {
                void ensureLocalApi()
                  .shell.openExternal(flow.verificationUrl)
                  .catch(() => setError("Could not open sign-in. Try again."));
              }}
            >
              Open sign-in page
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || readOnly}
              onClick={() => {
                setBusy(true);
                void cancelAuth({
                  environmentId,
                  input: { providerInstanceId, sessionId: flow.sessionId },
                })
                  .then((result) => {
                    if (result._tag === "Success") setFlow(null);
                    else setError("Could not cancel sign-in. Try again.");
                  })
                  .finally(() => setBusy(false));
              }}
            >
              Cancel sign-in
            </Button>
          </div>
          <p role="status" className="text-xs text-muted-foreground">
            Waiting for sign-in…
          </p>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          {status.data?.accounts
            .filter((account) => account.flow === "device_code" && !account.loggedIn)
            .map((account) => (
              <Button
                key={account.id}
                variant="outline"
                size="sm"
                disabled={busy || readOnly}
                onClick={() => void signIn(account.id)}
              >
                Sign in with {account.name}
              </Button>
            ))}
        </div>
      )}
      {selectedProvider ? (
        <>
          <label className="grid gap-1 text-xs">
            Account
            <select
              aria-label="Model account"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              disabled={busy || readOnly}
              value={selectedProvider.id}
              onChange={(event) => {
                setProviderId(event.target.value);
                selectModel("");
                setConfirmation(null);
              }}
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            Model
            <select
              aria-label="Hermes model"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              disabled={busy || readOnly}
              value={selectedModel}
              onChange={(event) => {
                selectModel(event.target.value);
                setConfirmation(null);
              }}
            >
              {selectedProvider.models.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          {confirmation ? <p>{confirmation}</p> : null}
          <Button
            size="sm"
            disabled={busy || readOnly || !selectedModel}
            onClick={() => void saveModel(confirmation !== null)}
          >
            {confirmation ? "Confirm model" : "Use this model"}
          </Button>
        </>
      ) : null}
      {status.isPending ? <p role="status">Checking connected accounts…</p> : null}
      {error || status.error || poll.error ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? status.error ?? poll.error}
        </p>
      ) : null}
      {status.error ? (
        <Button size="sm" variant="outline" onClick={status.refresh}>
          Retry account check
        </Button>
      ) : null}
    </div>
  );
}
