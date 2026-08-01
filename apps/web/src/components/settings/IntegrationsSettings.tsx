import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { OpenRouterIntegrationStatus } from "@t3tools/contracts/voice";

import {
  deleteOpenRouterCredential,
  getOpenRouterIntegration,
  putOpenRouterCredential,
  validateOpenRouterCredential,
} from "../../cloud/voiceInput";
import { invalidateVoicePreflight } from "../../voice/useWebVoiceInput";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function statusLabel(status: OpenRouterIntegrationStatus | null): string {
  if (!status) return "Checking";
  switch (status.state) {
    case "connected":
      return "Connected";
    case "invalid":
      return "Error";
    case "unavailable":
      return "Unavailable";
    case "validating":
      return "Validating";
    default:
      return "Not configured";
  }
}

export function IntegrationsSettings() {
  const [status, setStatus] = useState<OpenRouterIntegrationStatus | null>(null);
  useEffect(() => {
    void getOpenRouterIntegration()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("integrations")}>
        <SettingsRow
          title="OpenRouter"
          description="Connect an account-wide OpenRouter credential for Voice Input."
          status={`${statusLabel(status)} · Used by Voice Input`}
          control={
            <Button size="sm" render={<Link to="/settings/integrations/openrouter" />}>
              {status?.configured ? "Manage" : "Configure"}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function OpenRouterIntegrationSettings() {
  const [status, setStatus] = useState<OpenRouterIntegrationStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (operation: () => Promise<OpenRouterIntegrationStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await operation());
      invalidateVoicePreflight();
      setApiKey("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "OpenRouter request failed.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void run(getOpenRouterIntegration);
  }, []);

  return (
    <SettingsPageContainer>
      <SettingsSection title="OpenRouter">
        <SettingsRow
          title="Connection"
          description="Your key is validated before replacement, encrypted at rest, and never returned to clients or chat environments."
          status={`${statusLabel(status)}${status?.credentialHint ? ` · ${status.credentialHint}` : ""}${
            status?.lastValidatedAt
              ? ` · Validated ${new Date(status.lastValidatedAt).toLocaleString()}`
              : ""
          }`}
        />
        <SettingsRow
          title={status?.configured ? "Replace API key" : "API key"}
          description="Requests are routed by OpenRouter to the upstream providers selected by your Voice Input models."
        >
          <form
            className="flex flex-col gap-2 pt-3 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (apiKey.trim()) void run(() => putOpenRouterCredential(apiKey));
            }}
          >
            <input
              type="password"
              autoComplete="off"
              data-1p-ignore
              className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm"
              aria-label="OpenRouter API key"
              placeholder={status?.configured ? "Enter a replacement key" : "sk-or-v1-…"}
              value={apiKey}
              onChange={(event) => setApiKey(event.currentTarget.value)}
            />
            <Button type="submit" disabled={busy || !apiKey.trim()}>
              Validate and Connect
            </Button>
          </form>
          {error ? <p className="pt-2 text-sm text-destructive">{error}</p> : null}
          <p className="pt-2 text-xs text-muted-foreground">
            Create or manage keys at{" "}
            <a
              className="underline underline-offset-2"
              href="https://openrouter.ai/settings/keys"
              target="_blank"
              rel="noreferrer"
            >
              OpenRouter
            </a>
            .
          </p>
        </SettingsRow>
        {status?.configured ? (
          <SettingsRow
            title="Manage connection"
            description="Disconnecting deletes the credential immediately while preserving Voice Input preferences."
            control={
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(validateOpenRouterCredential)}
                >
                  Revalidate
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void run(deleteOpenRouterCredential)}
                >
                  Disconnect
                </Button>
              </div>
            }
          />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
