import { createFileRoute } from "@tanstack/react-router";

import { OpenRouterIntegrationSettings } from "../components/settings/IntegrationsSettings";

export const Route = createFileRoute("/settings/integrations/openrouter")({
  component: OpenRouterIntegrationSettings,
});
