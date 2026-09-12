import type { EnvironmentId, ProjectId, ServerSettingsPatch } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

type ProjectTargets = ReadonlyArray<{ environmentId: EnvironmentId; id: ProjectId }>;
export function ProjectAutoPullSettings({ projects }: { projects?: ProjectTargets }) {
  return <ProjectBooleanSettings kind="pull" projects={projects} />;
}
export function ProjectBrowserAccessSettings({ projects }: { projects: ProjectTargets }) {
  return <ProjectBooleanSettings kind="browser" projects={projects} />;
}

/** Sparse project patches preserve other checkouts, including concurrent changes on another device. */
function ProjectBooleanSettings({
  projects,
  kind,
}: {
  projects?: ProjectTargets | undefined;
  kind: "pull" | "browser";
}) {
  const { environments } = useEnvironments();
  const title = kind === "pull" ? "Automatically pull" : "Agent browser access";
  const overrideKey =
    kind === "pull" ? "projectAutoPullOverrides" : "projectAgentBrowserAccessOverrides";
  const defaultKey = kind === "pull" ? "defaultAutoPull" : "enableAgentBrowserAccess";
  const capability = kind === "pull" ? "projectAutoPull" : "projectBrowserAccess";
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
      environment.serverConfig?.environment.capabilities[capability] === true,
  );
  const values = targets.flatMap((environment) => {
    const settings = environment.serverConfig?.settings;
    return projects === undefined
      ? [
          {
            choice: settings?.[defaultKey] === true ? "on" : "off",
            enabled: settings?.[defaultKey],
          },
        ]
      : projects
          .filter((project) => project.environmentId === environment.environmentId)
          .map((project) => {
            const value = settings?.[overrideKey][project.id];
            return {
              choice: value === undefined ? "inherit" : value ? "on" : "off",
              enabled: value ?? settings?.[defaultKey],
            };
          });
  });
  const selected = values.every((value) => value.choice === values[0]?.choice)
    ? (values[0]?.choice ?? "off")
    : "mixed";
  const mixed =
    selected === "mixed" || values.some((value) => value.enabled !== values[0]?.enabled);
  async function save(value: string | null) {
    if (pendingRef.current || !value || !["on", "off", "inherit"].includes(value)) return;
    pendingRef.current = true;
    setPending(true);
    try {
      const results = await Promise.all(
        writable.map(async (environment) => {
          const patch: ServerSettingsPatch =
            projects === undefined
              ? { [defaultKey]: value === "on" }
              : {
                  [overrideKey]: Object.fromEntries(
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
          title: `${title} not saved`,
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
      title={title}
      description={`${kind === "pull" ? "Keeps clean default branches current when there are no local commits." : "Allow agents to use the shared browser. Applies when their next session is prepared."} ${projects ? "Applies to every checkout in this group." : "Default for projects on connected machines."}${writable.length < targets.length ? " Offline or older machines keep their settings." : ""}`}
      status={mixed ? "Differs by machine or checkout" : undefined}
      control={
        <Select
          value={selected}
          disabled={pending || writable.length === 0}
          onValueChange={(value) => void save(value)}
        >
          <SelectTrigger size="sm" aria-label={title}>
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
