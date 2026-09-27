import { createFileRoute } from "@tanstack/react-router";

import {
  ScheduledTasksSettings,
  validateScheduledTasksSearch,
} from "../components/settings/ScheduledTasksSettings";

function SettingsScheduledTasksRoute() {
  const target = Route.useSearch();
  return <ScheduledTasksSettings {...target} />;
}

export const Route = createFileRoute("/settings/scheduled-tasks")({
  validateSearch: validateScheduledTasksSearch,
  component: SettingsScheduledTasksRoute,
});
