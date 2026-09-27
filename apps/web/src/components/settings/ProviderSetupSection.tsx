import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  ANTIGRAVITY_AUTH_METHODS,
  type AntigravityAuthMethod,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";

interface ProviderSetupSectionProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly binaryPath?: string | undefined;
  readonly authMethod?: AntigravityAuthMethod | undefined;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onEnable: () => void;
}

/** Read the configured method from the instance config. Unknown values fall back to personal. */
export function readAntigravityAuthMethod(config: unknown): AntigravityAuthMethod {
  const value =
    config !== null && typeof config === "object" && "authMethod" in config
      ? config.authMethod
      : undefined;
  return (
    ANTIGRAVITY_AUTH_METHODS.find((method) => method.value === value)?.value ?? "oauth-personal"
  );
}

/** Setup state belongs to the selected environment and is never saved in client settings. */
export function ProviderSetupSection(props: ProviderSetupSectionProps) {
  return (
    <section aria-label="Antigravity setup" className="grid gap-3 text-xs">
      <p>Antigravity runs on {props.environmentLabel}.</p>
      {!props.enabled ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Enable it to use it in threads.</span>
          {!props.readOnly ? (
            <Button size="xs" variant="outline" onClick={props.onEnable}>
              Enable Antigravity
            </Button>
          ) : null}
        </div>
      ) : null}
      {props.readOnly ? (
        <p className="text-muted-foreground">This connection cannot change provider setup.</p>
      ) : props.provider?.setup === undefined ? (
        <p className="text-muted-foreground">
          Update this environment to install Antigravity and sign in with Google here.
        </p>
      ) : (
        <ProviderSetupActions
          key={`${props.environmentId}:${props.instanceId}`}
          environmentId={props.environmentId}
          environmentLabel={props.environmentLabel}
          instanceId={props.instanceId}
          provider={props.provider}
          binaryPath={props.binaryPath}
          authMethod={props.authMethod ?? "oauth-personal"}
          enabled={props.enabled}
        />
      )}
    </section>
  );
}

function ProviderSetupActions({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  enabled,
  binaryPath,
}: Pick<
  ProviderSetupSectionProps,
  "environmentId" | "environmentLabel" | "instanceId" | "enabled" | "binaryPath"
> & {
  readonly provider: ServerProvider;
  readonly authMethod: AntigravityAuthMethod;
}) {
  const target = { environmentId, input: { instanceId } };
  const authQuery = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const installQuery = useEnvironmentQuery(serverEnvironment.providerInstallState(target));
  const auth = authQuery.data;
  const installation = installQuery.data;
  const commandOptions = { reportFailure: false, reportDefect: false };
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, commandOptions);
  const cancelInstall = useAtomCommand(serverEnvironment.cancelProviderInstall, commandOptions);
  const removeInstall = useAtomCommand(
    serverEnvironment.removeProviderInstallation,
    commandOptions,
  );
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const authActive =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const installActive =
    installation?.phase === "downloading" ||
    installation?.phase === "extracting" ||
    installation?.phase === "verifying";
  const usesCustomBinary = Boolean(binaryPath?.trim());
  const installed =
    provider.installed || (!usesCustomBinary && installation?.installedVersion != null);
  const queryError = authQuery.error ?? installQuery.error;
  const actionsDisabled = pendingLabel !== null || queryError !== null;
  const installationStatusMessage =
    installation?.phase === "downloading"
      ? `Downloading ${(installation.downloadedBytes / 1_000_000).toFixed(1)} MB${installation.totalBytes === null ? "" : ` of ${(installation.totalBytes / 1_000_000).toFixed(1)} MB`}.`
      : installation?.phase === "extracting"
        ? "Extracting Antigravity."
        : installation?.phase === "verifying"
          ? "Checking the downloaded runtime."
          : installed
            ? "Antigravity is installed."
            : usesCustomBinary
              ? enabled
                ? "The configured Antigravity runtime is unavailable."
                : "The configured Antigravity runtime has not been checked."
              : "Install the official Antigravity runtime before signing in.";

  async function runCommand<A, E>(
    label: string,
    request: () => Promise<AtomCommandResult<A, E>>,
  ): Promise<boolean> {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPendingLabel(label);
    setError(null);
    try {
      const result = await request();
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : "Provider setup failed.");
        }
        return false;
      }
      return true;
    } catch {
      setError("Provider setup failed. Try again.");
      return false;
    } finally {
      pendingRef.current = false;
      setPendingLabel(null);
    }
  }

  async function removeRuntime() {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Remove the downloaded Antigravity runtime from ${environmentLabel}? Google sign-in and thread history are kept.`,
    );
    if (confirmed) {
      await runCommand("Removing runtime", () => removeInstall(target));
    }
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-2">
        <p className="font-medium">Runtime</p>
        <p role="status" className="text-muted-foreground">
          {installationStatusMessage}
        </p>
        {installation?.phase === "downloading" &&
        installation.totalBytes !== null &&
        installation.totalBytes > 0 ? (
          <progress
            aria-label="Antigravity download"
            className="h-1 w-full accent-foreground"
            value={installation.downloadedBytes}
            max={installation.totalBytes}
          />
        ) : null}
        {installation?.message && installation.message !== installationStatusMessage ? (
          <p className="text-muted-foreground [overflow-wrap:anywhere]">{installation.message}</p>
        ) : null}
        {usesCustomBinary ? (
          <p className="text-muted-foreground">
            This instance uses the binary path below. Installing a managed runtime does not change
            that path.
          </p>
        ) : null}
        {!installed && !usesCustomBinary && !installActive && installation?.totalBytes ? (
          <p className="text-muted-foreground">
            Downloads {Math.ceil(installation.totalBytes / 1_000_000)} MB from Google.
          </p>
        ) : null}
        {!installed && !provider.setup?.canInstall ? (
          <p className="text-muted-foreground">
            Automatic installation is unavailable here. Set an existing binary path below or use a
            supported remote environment.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {installActive && installation.operationId ? (
            <Button
              size="xs"
              variant="outline"
              disabled={actionsDisabled}
              onClick={() => {
                const operationId = installation.operationId;
                if (!operationId) return;
                void runCommand("Cancelling installation", () =>
                  cancelInstall({ environmentId, input: { instanceId, operationId } }),
                );
              }}
            >
              Cancel installation
            </Button>
          ) : !installActive && provider.setup?.canInstall ? (
            <Button
              size="xs"
              variant="outline"
              disabled={actionsDisabled || installation === null || authActive}
              onClick={() => void runCommand("Starting installation", () => startInstall(target))}
            >
              {installation?.installedVersion
                ? installation.version && installation.version !== installation.installedVersion
                  ? "Update Antigravity"
                  : "Reinstall Antigravity"
                : installation?.phase === "failed" || installation?.phase === "cancelled"
                  ? "Retry installation"
                  : installed
                    ? "Install managed runtime"
                    : "Install Antigravity"}
            </Button>
          ) : null}
          {installation?.canRemove && !installActive ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={actionsDisabled || authActive}
              onClick={() => void removeRuntime()}
            >
              Remove downloaded runtime
            </Button>
          ) : null}
        </div>
      </div>

      <div className="border-t border-border/60">
        <ProviderAuthenticationSection
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          instanceId={instanceId}
          provider={provider}
          readOnly={false}
        />
      </div>

      {pendingLabel ? <p role="status">{pendingLabel}.</p> : null}
      {error || queryError ? (
        <div className="grid gap-2">
          <p role="alert" className="text-destructive [overflow-wrap:anywhere]">
            {error ?? queryError}
          </p>
          {queryError ? (
            <Button
              size="xs"
              variant="outline"
              className="w-fit"
              onClick={() => {
                authQuery.refresh();
                installQuery.refresh();
              }}
            >
              Retry setup status
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
