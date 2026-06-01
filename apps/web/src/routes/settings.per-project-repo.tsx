import { createFileRoute } from "@tanstack/react-router";

import { PerProjectRepoSettingsPanel } from "../components/settings/PerProjectRepoSettings";

export const Route = createFileRoute("/settings/per-project-repo")({
  component: PerProjectRepoSettingsPanel,
});
