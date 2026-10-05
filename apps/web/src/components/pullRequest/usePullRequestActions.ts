/**
 * The actions a pull request offers, shared by every surface that performs them — the detail
 * panel and the list's quick actions. Two copies of "merge" would drift apart one fix at a time;
 * these hooks are where that behavior lives, and the panels are only where it is rendered.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, PullRequestMergeMethod } from "@t3tools/contracts";
import { resolveProjectPullRequestMergeMethod } from "@t3tools/shared/serverSettings";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";

/**
 * The project's merge method, then the machine's. Null when neither is set, where the method
 * last chosen on this device applies instead.
 */
export function usePullRequestDefaultMergeMethod(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): PullRequestMergeMethod | null {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  return settings === null ? null : resolveProjectPullRequestMergeMethod(settings, projectId);
}

/** The same answer read once, at a click, so a long list of rows subscribes to nothing. */
export function readPullRequestDefaultMergeMethod(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): PullRequestMergeMethod | null {
  const settings = appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId));
  return settings === null ? null : resolveProjectPullRequestMergeMethod(settings, projectId);
}
