import type { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import {
  deriveProjectProviderRows,
  projectProviderOverridePatch,
  type ProjectProviderChoice,
} from "./ProjectProviderSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type ProjectTargets = ReadonlyArray<{ environmentId: EnvironmentId; id: ProjectId }>;

const onOff = (enabled: boolean | "mixed") =>
  enabled === "mixed" ? "differs by machine" : enabled ? "on" : "off";

/**
 * Turns providers on or off for one project, in either direction over the
 * machine's switch. Machines too old to enforce it are left out rather than
 * offered a control that would do nothing there.
 */
export function ProjectProviderSettings({ projects }: { projects: ProjectTargets }) {
  const { environments } = useEnvironments();
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const targets = environments.filter((environment) =>
    projects.some((project) => project.environmentId === environment.environmentId),
  );
  const writable = targets.flatMap((environment) => {
    const config = environment.serverConfig;
    return environment.connection.phase === "connected" &&
      config?.environment.capabilities.projectProviderInstanceOverrides === true
      ? [
          {
            environment,
            projectIds: projects
              .filter((project) => project.environmentId === environment.environmentId)
              .map((project) => project.id),
            settings: config.settings,
            providers: config.providers,
          },
        ]
      : [];
  });
  const rows = deriveProjectProviderRows(writable);
  if (rows.length === 0) return null;

  async function save(instanceId: ProviderInstanceId, value: string | null) {
    if (pendingRef.current || (value !== "inherit" && value !== "on" && value !== "off")) return;
    const choice: ProjectProviderChoice = value;
    pendingRef.current = true;
    setPending(true);
    try {
      const results = await Promise.all(
        writable.map(async (target) => ({
          target,
          result: await update({
            environmentId: target.environment.environmentId,
            input: { patch: projectProviderOverridePatch(target.projectIds, instanceId, choice) },
          }),
        })),
      );
      const failed = results.filter(({ result }) => result._tag === "Failure");
      if (failed.length > 0)
        toastManager.add({
          type: "error",
          title: "Provider not saved",
          description: `Could not update ${failed.map(({ target }) => target.environment.label).join(", ")}. Other machines may have saved the change.`,
        });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <SettingsSection title="Providers">
      {rows.map((row) => (
        <SettingsRow
          key={row.instanceId}
          title={row.displayName}
          description={`For this project only. New turns here follow it, including queued messages and delegated tasks.${writable.length < targets.length ? " Offline or older machines keep their settings." : ""}`}
          status={row.choice === "mixed" ? "Differs by checkout" : undefined}
          control={
            <Select
              value={row.choice}
              disabled={pending}
              onValueChange={(value) => void save(row.instanceId, value)}
            >
              <SelectTrigger size="sm" aria-label={`${row.displayName} for this project`}>
                <SelectValue>
                  {row.choice === "mixed"
                    ? "Mixed"
                    : row.choice === "inherit"
                      ? `Machine default (${onOff(row.machineEnabled)})`
                      : row.choice === "on"
                        ? "On"
                        : "Off"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="inherit">
                  Machine default ({onOff(row.machineEnabled)})
                </SelectItem>
                <SelectItem value="on">On</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ))}
    </SettingsSection>
  );
}
