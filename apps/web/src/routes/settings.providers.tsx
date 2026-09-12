import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ProviderSettingsPanel } from "../components/settings/SettingsPanels";

function SettingsProvidersRoute() {
  const search = Route.useSearch();
  return (
    <ProviderSettingsPanel
      includeDriver={(driver) => driver !== "hermes"}
      {...(search.environmentId
        ? { initialEnvironmentId: EnvironmentId.make(search.environmentId) }
        : {})}
      {...(search.instanceId
        ? { initialInstanceId: ProviderInstanceId.make(search.instanceId) }
        : {})}
    />
  );
}

export const Route = createFileRoute("/settings/providers")({
  component: SettingsProvidersRoute,
  validateSearch: (
    search: Record<string, unknown>,
  ): { environmentId?: string; instanceId?: string } => ({
    ...(typeof search.environmentId === "string" && search.environmentId.trim()
      ? { environmentId: search.environmentId }
      : {}),
    ...(typeof search.instanceId === "string" && search.instanceId.trim()
      ? { instanceId: search.instanceId }
      : {}),
  }),
});
