import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

/** Sparse project patches preserve other checkouts, including concurrent changes on another device. */
export function ProjectAutoPullSettings({
  projects,
}: {
  projects?: ReadonlyArray<{ environmentId: EnvironmentId; id: ProjectId }>;
}) {
  const { environments } = useEnvironments();
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const targets = environments.filter(
    (environment) =>
      projects === undefined ||
      projects.some((project) => project.environmentId === environment.environmentId),
  );
  const writable = targets.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.projectAutoPull === true,
  );
  const values = targets.flatMap((environment) => {
    const settings = environment.serverConfig?.settings;
    return projects === undefined
      ? [settings?.defaultAutoPull === true ? "on" : "off"]
      : projects
          .filter((project) => project.environmentId === environment.environmentId)
          .map((project) => {
            const value = settings?.projectAutoPullOverrides[project.id];
            return value === undefined ? "inherit" : value ? "on" : "off";
          });
  });
  const selected = values.every((value) => value === values[0]) ? (values[0] ?? "off") : "mixed";
  async function save(value: string | null) {
    if (pendingRef.current || !value || !["on", "off", "inherit"].includes(value)) return;
    pendingRef.current = true;
    setPending(true);
    try {
      const results = await Promise.all(
        writable.map(async (environment) => {
          const patch =
            projects === undefined
              ? { defaultAutoPull: value === "on" }
              : {
                  projectAutoPullOverrides: Object.fromEntries(
                    projects
                      .filter((project) => project.environmentId === environment.environmentId)
                      .map((project) => [project.id, value === "inherit" ? null : value === "on"]),
                  ),
                };
          return {
            environment,
            result: await update({ environmentId: environment.environmentId, input: { patch } }),
          };
        }),
      );
      const failed = results.filter(({ result }) => result._tag === "Failure");
      if (failed.length)
        toastManager.add({
          type: "error",
          title: "Automatic pull not saved",
          description: `Could not update ${failed.map(({ environment }) => environment.label).join(", ")}. Other machines may have saved the change.`,
        });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  return (
    <SettingsRow
      id={projects ? undefined : "automatic-project-pull"}
      title="Automatically pull"
      description={`Keeps clean default branches current when there are no local commits. ${projects ? "Applies to every checkout in this group." : "Default for projects on connected machines."}${writable.length < targets.length ? " Offline or older machines keep their settings." : ""}`}
      status={selected === "mixed" ? "Differs by machine or checkout" : undefined}
      control={
        <Select
          value={selected}
          disabled={pending || writable.length === 0}
          onValueChange={(value) => void save(value)}
        >
          <SelectTrigger size="sm" aria-label="Automatic project pull">
            <SelectValue>
              {selected === "mixed"
                ? "Mixed"
                : selected === "inherit"
                  ? "Machine default"
                  : selected === "on"
                    ? "On"
                    : "Off"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {projects ? <SelectItem value="inherit">Machine default</SelectItem> : null}
            <SelectItem value="off">Off</SelectItem>
            <SelectItem value="on">On</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}
