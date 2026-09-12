import type { ProviderInstanceId, ServerConfig } from "@t3tools/contracts";
import { useState } from "react";
import {
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
} from "../../onboarding/providerReadiness.logic";
import {
  AgentInstallTerminal,
  type AgentTerminalSession,
} from "../onboarding/AgentInstallTerminal";
import { getProviderStatusMessage, hasProviderSetup } from "../chat/ProviderStatusBanner";
import { Button } from "../ui/button";

export function ProviderAccountSetup({
  config,
  instanceId,
  disabled,
  onRefresh,
}: {
  config: ServerConfig;
  instanceId: ProviderInstanceId;
  disabled: boolean;
  onRefresh: () => void;
}) {
  const provider = config.providers.find((provider) => provider.instanceId === instanceId);
  const [session, setSession] = useState<AgentTerminalSession | null>(null);
  if (!provider || !hasProviderSetup(provider)) return null;
  const available = config.environment.capabilities.providerTerminalEnvironment === true;
  function openTerminal(kind: "install" | "login") {
    if (
      disabled ||
      !available ||
      !provider ||
      (provider.driver !== "codex" && provider.driver !== "claudeAgent")
    )
      return;
    const driver = provider.driver === "codex" ? "codex" : "claudeAgent";
    setSession({
      environmentId: config.environment.environmentId,
      driver,
      providerInstanceId: provider.instanceId,
      cwd: config.cwd,
      keybindings: config.keybindings,
      command:
        kind === "install"
          ? resolveOnboardingProviderInstallCommand(driver, config.environment.platform.os)
          : resolveOnboardingProviderLoginCommand(
              provider,
              config.settings,
              config.environment.platform.os,
            ),
    });
  }
  return (
    <section
      className="m-2 rounded-lg border border-border/60 bg-muted/20 p-3"
      aria-label="Provider setup"
    >
      <h3 className="text-sm font-medium">Account setup</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {provider.status === "ready"
          ? "Sign in again to change the account used by this provider."
          : getProviderStatusMessage(provider)}
      </p>
      {!available ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Update this server to use its account-specific setup terminal.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {!provider.installed ? (
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || !available || session !== null}
            onClick={() => openTerminal("install")}
          >
            Install agent
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || !available || session !== null || !provider.installed}
          onClick={() => openTerminal("login")}
        >
          Sign in
        </Button>
        <Button size="xs" variant="ghost" disabled={disabled} onClick={onRefresh}>
          Refresh status
        </Button>
      </div>
      {session ? (
        <AgentInstallTerminal
          key={`${session.providerInstanceId}:${session.command}`}
          session={session}
          onClose={() => {
            setSession(null);
            onRefresh();
          }}
        />
      ) : null}
    </section>
  );
}
