import { useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { EnvironmentId, HermesWorkModelAuthStartResult } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { hermesEnvironment } from "../../state/hermes";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkRefresh } from "../settings/useWorkRefresh";

type Login = HermesWorkModelAuthStartResult & { provider: string; expiresAt: number };

export function HermesModelSetup({
  environmentId,
  providerInstanceId,
  onConfigured,
}: {
  environmentId: EnvironmentId;
  providerInstanceId: string;
  onConfigured: () => void;
}) {
  const input = { providerInstanceId, profile: "default" };
  const query = useEnvironmentQuery(hermesEnvironment.workModelStatus({ environmentId, input }));
  const start = useAtomCommand(hermesEnvironment.workModelAuthStart);
  const cancel = useAtomCommand(hermesEnvironment.workModelAuthCancel);
  const setModel = useAtomCommand(hermesEnvironment.workModelSet);
  const [login, setLogin] = useState<Login | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [model, setModelName] = useState<string | null>(null);
  const pollQuery = useEnvironmentQuery(
    login
      ? hermesEnvironment.workModelAuthPoll({
          environmentId,
          input: {
            providerInstanceId,
            profile: "default",
            provider: login.provider,
            sessionId: login.sessionId,
          },
        })
      : null,
  );
  useWorkRefresh(pollQuery.refresh, login !== null, Math.max(1, login?.pollInterval ?? 5) * 1000);
  useEffect(() => {
    if (!login) return;
    if (Date.now() >= login.expiresAt) {
      setError("Sign-in expired. Start sign-in again to get a new code.");
      setLogin(null);
      return;
    }
    if (pollQuery.error) {
      setError(pollQuery.error);
      setLogin(null);
      return;
    }
    if (pollQuery.data?.status === "approved") {
      setLogin(null);
      setError(null);
      query.refresh();
    } else if (pollQuery.data && pollQuery.data.status !== "pending") {
      setError(pollQuery.data.message ?? `Sign-in ${pollQuery.data.status}. Start again to retry.`);
      setLogin(null);
    }
  }, [login, pollQuery.data, pollQuery.error, query.refresh]);
  useWorkRefresh(query.refresh, !login && !busy);
  const signIn = async (provider: string) => {
    if (busy || login) return;
    setBusy(true);
    setError(null);
    try {
      const result = await start({ environmentId, input: { ...input, provider } });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } else
        setLogin({
          ...result.value,
          provider,
          expiresAt: Date.now() + result.value.expiresIn * 1000,
        });
    } finally {
      setBusy(false);
    }
  };
  const save = async (provider: string, name: string, confirmExpensiveModel = false) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await setModel({
        environmentId,
        input: { ...input, provider, model: name, confirmExpensiveModel },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        return;
      }
      if (result.value.confirmRequired) {
        showConfirmDialog({
          title: "Use this model?",
          message: result.value.message ?? "Hermes requires confirmation before using this model.",
          confirmText: "Use model",
          onConfirm: () => {
            void save(provider, name, true);
          },
        });
      } else if (result.value.ok) {
        query.refresh();
        onConfigured();
      } else setError(result.value.message ?? "Hermes could not select this model.");
    } finally {
      setBusy(false);
    }
  };
  const authenticated = query.data?.providers.filter((provider) => provider.authenticated) ?? [];
  const provider =
    authenticated.find((candidate) => candidate.id === selectedProvider) ??
    authenticated.find((candidate) => candidate.id === query.data?.provider) ??
    authenticated[0];
  const chosenModel =
    model ??
    ((provider && provider.id === query.data?.provider ? query.data?.model : provider?.models[0]) ||
      "");
  const action = (label: string, onPress: () => void, disabled = false) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      disabled={disabled || busy}
      onPress={onPress}
      className="rounded-xl border border-secondary-border p-3"
    >
      <Text>{label}</Text>
    </Pressable>
  );
  return (
    <View className="gap-3">
      {error || query.error ? (
        <Text className="text-sm text-red-500">{error ?? query.error}</Text>
      ) : null}
      {login ? (
        <>
          <Text>Enter this code on the sign-in page:</Text>
          <Text selectable className="font-t3-semibold">
            {login.userCode}
          </Text>
          {action("Copy code", () => {
            void Clipboard.setStringAsync(login.userCode).catch((cause) => setError(String(cause)));
          })}
          {action("Open sign-in page", () => {
            try {
              const url = new URL(login.verificationUrl);
              if (url.protocol !== "https:")
                throw new Error("Hermes returned an unsupported sign-in address.");
              void Linking.openURL(url.href).catch((cause) => setError(String(cause)));
            } catch (cause) {
              setError(String(cause));
            }
          })}
          <Text className="text-sm text-foreground-muted">
            Waiting for sign-in. Return here afterward to select your model.
          </Text>
          {action("Cancel sign-in", () => {
            void cancel({ environmentId, input: { ...input, sessionId: login.sessionId } }).then(
              (result) => {
                if (result._tag === "Success") setLogin(null);
                else if (!isAtomCommandInterrupted(result)) {
                  const cause = squashAtomCommandFailure(result);
                  setError(cause instanceof Error ? cause.message : String(cause));
                }
              },
            );
          })}
        </>
      ) : (
        query.data?.accounts
          .filter((account) => !account.loggedIn)
          .map((account) => (
            <View key={account.id} className="gap-2">
              {account.flow === "device_code" ? (
                action(`Sign in to ${account.name}`, () => {
                  void signIn(account.id);
                })
              ) : (
                <Text className="text-sm">
                  {account.name}: sign in or configure an API key through Hermes on the hosting
                  environment, then refresh here.
                </Text>
              )}
            </View>
          ))
      )}
      {authenticated.length > 0 ? (
        <>
          <Text className="font-t3-semibold">Choose a model</Text>
          <ScrollView horizontal contentContainerClassName="gap-2">
            {authenticated.map((candidate) =>
              action(candidate.name, () => {
                setSelectedProvider(candidate.id);
                setModelName(null);
              }),
            )}
          </ScrollView>
          <Text>{provider?.name}</Text>
          <ScrollView horizontal contentContainerClassName="gap-2">
            {provider?.models.map((name) => action(name, () => setModelName(name)))}
          </ScrollView>
          <TextInput
            accessibilityLabel="Model"
            placeholder="Model name"
            value={chosenModel}
            onChangeText={setModelName}
            editable={!busy}
            autoCapitalize="none"
            className="rounded-xl border border-secondary-border p-3 text-foreground"
          />
          {action(
            "Use model and verify Hermes",
            () => {
              if (provider) void save(provider.id, chosenModel.trim());
            },
            !provider || !chosenModel.trim(),
          )}
        </>
      ) : null}
      {action("Refresh model connection", query.refresh, query.isPending)}
    </View>
  );
}
