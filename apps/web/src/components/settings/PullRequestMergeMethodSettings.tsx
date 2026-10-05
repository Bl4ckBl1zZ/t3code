import type {
  EnvironmentId,
  ProjectId,
  PullRequestMergeMethod,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "../pullRequest/pullRequestDetail.logic";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

type ProjectTargets = ReadonlyArray<{ environmentId: EnvironmentId; id: ProjectId }>;
type Choice = PullRequestMergeMethod | "last" | "inherit";

const METHODS: ReadonlyArray<PullRequestMergeMethod> = ["merge", "squash", "rebase"];

/**
 * The merge method pull requests start with. Without `projects` this is the machine default, where
 * "Last used" keeps each device's own last choice; with them it is a sparse per-project override
 * that "Machine default" removes. A repository that does not allow the method falls back to one
 * it does.
 */
export function PullRequestMergeMethodSettings({ projects }: { projects?: ProjectTargets }) {
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
      environment.serverConfig?.environment.capabilities.pullRequestMergeMethodDefaults === true,
  );
  const choices = writable.flatMap((environment): Choice[] => {
    const settings = environment.serverConfig?.settings;
    if (projects === undefined) return [settings?.pullRequestMergeMethod ?? "last"];
    return projects
      .filter((project) => project.environmentId === environment.environmentId)
      .map((project) => settings?.projectPullRequestMergeMethodOverrides[project.id] ?? "inherit");
  });
  const fallback: Choice = projects === undefined ? "last" : "inherit";
  const selected: Choice | "mixed" = choices.every((choice) => choice === choices[0])
    ? (choices[0] ?? fallback)
    : "mixed";

  async function save(value: string | null) {
    if (pendingRef.current || value === null) return;
    const method = METHODS.find((candidate) => candidate === value) ?? null;
    if (method === null && value !== fallback) return;
    pendingRef.current = true;
    setPending(true);
    try {
      const results = await Promise.all(
        writable.map(async (environment) => {
          const patch: ServerSettingsPatch =
            projects === undefined
              ? { pullRequestMergeMethod: method }
              : {
                  projectPullRequestMergeMethodOverrides: Object.fromEntries(
                    projects
                      .filter((project) => project.environmentId === environment.environmentId)
                      .map((project) => [project.id, method]),
                  ),
                };
          return {
            environment,
            result: await update({ environmentId: environment.environmentId, input: { patch } }),
          };
        }),
      );
      const failed = results.filter(({ result }) => result._tag === "Failure");
      if (failed.length > 0)
        toastManager.add({
          type: "error",
          title: "Merge method not saved",
          description: `Could not update ${failed.map(({ environment }) => environment.label).join(", ")}. Other machines may have saved the change.`,
        });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  const label = (choice: Choice | "mixed") =>
    choice === "mixed"
      ? "Mixed"
      : choice === "last"
        ? "Last used"
        : choice === "inherit"
          ? "Machine default"
          : PULL_REQUEST_MERGE_METHOD_LABELS[choice];

  return (
    <SettingsRow
      id={projects ? undefined : "pull-request-merge-method"}
      title="Pull request merge method"
      description={`${
        projects
          ? "The method this project's pull requests start with. Applies to every checkout in this group."
          : "The method pull requests start with. Last used keeps the method you last picked on each device."
      } A repository that does not allow it uses one it does.${
        writable.length < targets.length ? " Offline or older machines keep their settings." : ""
      }`}
      status={selected === "mixed" ? "Differs by machine or checkout" : undefined}
      control={
        <Select
          value={selected}
          disabled={pending || writable.length === 0}
          onValueChange={(value) => void save(value)}
        >
          <SelectTrigger size="sm" aria-label="Pull request merge method">
            <SelectValue>{label(selected)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value={fallback}>{label(fallback)}</SelectItem>
            {METHODS.map((method) => (
              <SelectItem key={method} value={method}>
                {PULL_REQUEST_MERGE_METHOD_LABELS[method]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
