import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import type { EnvironmentId, HermesWorkSetupState } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/AppText";
import { hermesEnvironment } from "../../state/hermes";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkRefresh } from "../settings/useWorkRefresh";

import { HermesModelSetup } from "./HermesModelSetup";

/** Runs setup on the selected environment, including when this client is a remote phone. */
export function HermesSetupCard({
  environmentId,
  providerInstanceId = "hermes",
  environmentLabel,
  configured = false,
  onConnected,
  onStarted,
}: {
  environmentId: EnvironmentId;
  providerInstanceId?: string;
  environmentLabel?: string;
  configured?: boolean;
  onConnected?: () => void;
  onStarted?: () => void;
}) {
  const query = useEnvironmentQuery(
    hermesEnvironment.workSetupStatus({ environmentId, input: { providerInstanceId } }),
  );
  const start = useAtomCommand(hermesEnvironment.workSetupStart, { label: "Set up Hermes" });
  const [submitted, setSubmitted] = useState<HermesWorkSetupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSubmitted(null);
  }, [query.data]);
  const state = submitted ?? query.data;
  const modelQuery = useEnvironmentQuery(
    configured && state?.phase === "idle"
      ? hermesEnvironment.workModelStatus({
          environmentId,
          input: { providerInstanceId },
        })
      : null,
  );
  const needsModel =
    state?.phase === "needs_model" ||
    (configured && state?.phase === "idle" && modelQuery.data?.ready === false);
  const active =
    state?.phase === "installing" ||
    state?.phase === "configuring" ||
    state?.phase === "connecting";
  useWorkRefresh(query.refresh, true, active || busy ? 1_000 : 30_000);
  const notifiedConnected = useRef(false);
  useEffect(() => {
    if (state?.phase !== "connected") {
      notifiedConnected.current = false;
      return;
    }
    if (!notifiedConnected.current) {
      notifiedConnected.current = true;
      onConnected?.();
    }
  }, [onConnected, state?.phase]);
  const runSetup = async () => {
    if (busy || active) return;
    onStarted?.();
    setError(null);
    setBusy(true);
    try {
      const result = await start({ environmentId, input: { providerInstanceId } });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } else {
        setSubmitted(result.value);
        query.refresh();
      }
    } finally {
      setBusy(false);
    }
  };
  const label =
    state?.phase === "installing"
      ? "Installing Hermes…"
      : state?.phase === "configuring"
        ? "Configuring Hermes…"
        : state?.phase === "connecting"
          ? "Starting and verifying Hermes…"
          : needsModel
            ? "Connect a model to continue"
            : state?.phase === "connected"
              ? "Hermes setup completed"
              : "Set up Hermes";
  if (configured && state?.phase === "idle" && modelQuery.data?.ready) return null;
  return (
    <View className="gap-3 rounded-xl border border-secondary-border bg-card p-4">
      <Text className="font-t3-semibold">{label}</Text>
      {environmentLabel ? (
        <Text className="text-sm text-foreground-muted">On {environmentLabel}</Text>
      ) : null}
      <Text className="text-sm text-foreground-muted">
        {state?.phase === "connected"
          ? "Last setup completed successfully. You can verify the current connection again."
          : state?.message ||
            "Install Hermes, start its services, and verify the connection on this environment."}
      </Text>
      {needsModel ? (
        <Text className="text-sm">
          Hermes is installed, but a model login or API key is still required before starting a
          thread.
        </Text>
      ) : null}
      {needsModel ? (
        <HermesModelSetup
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          onConfigured={() => {
            void runSetup();
          }}
        />
      ) : null}
      {state?.model ? <Text className="text-sm">Model: {state.model}</Text> : null}
      {error || query.error ? (
        <Text className="text-sm text-red-500">{error ?? query.error}</Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy || active}
        onPress={() => {
          void runSetup();
        }}
        className="rounded-xl border border-secondary-border p-3"
      >
        <Text className="text-center font-t3-semibold">
          {busy
            ? "Starting setup…"
            : active
              ? label
              : needsModel
                ? "Check model connection"
                : state?.phase === "connected"
                  ? "Verify connection"
                  : state?.phase === "error"
                    ? "Retry setup"
                    : "Set up Hermes"}
        </Text>
      </Pressable>
    </View>
  );
}
