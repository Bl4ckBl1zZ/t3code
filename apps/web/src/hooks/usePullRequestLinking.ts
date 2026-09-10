import type { EnvironmentId, ScopedThreadRef, ThreadLinkedPullRequest } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { findProjectForChangeRequest, parseChangeRequestUrl } from "~/lib/openPullRequestLink";
import { useProjects, useServerConfigs } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

/** Resolve against this environment's known remotes, then persist a host-confirmed V2 link. */
export function usePullRequestLinking(environmentId?: EnvironmentId) {
  const configs = useServerConfigs();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const capabilities = environmentId
    ? configs.get(environmentId)?.environment.capabilities
    : undefined;
  const mode =
    capabilities?.threadPullRequestsV2 === true && capabilities.pullRequests === true
      ? "collection"
      : "unsupported";
  const read = useAtomCommand(pullRequestEnvironment.readDetail, { reportFailure: false });
  const update = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const resolve = (url: string) => {
    const parsed = parseChangeRequestUrl(url);
    return parsed ? findProjectForChangeRequest(projects, parsed) : undefined;
  };
  return {
    mode,
    unlink: async (threadRef: ScopedThreadRef, link: ThreadLinkedPullRequest) => {
      if (mode !== "collection" || !environmentId || threadRef.environmentId !== environmentId)
        throw new Error("This environment cannot unlink pull requests.");
      const result = await update({
        environmentId,
        input: { threadId: threadRef.threadId, unlinkPullRequest: link },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
    canLink: (url: string) => mode === "collection" && resolve(url) !== undefined,
    changeLink: async (threadRef: ScopedThreadRef, url: string, adding: boolean) => {
      const parsed = parseChangeRequestUrl(url);
      const project = resolve(url);
      if (
        mode !== "collection" ||
        !project ||
        !parsed ||
        threadRef.environmentId !== environmentId
      ) {
        throw new Error("This environment cannot link that pull request.");
      }
      const reference = {
        projectId: project.id,
        repository: project.repositoryIdentity?.displayName ?? parsed.repository,
        number: parsed.number,
      };
      // Unlinking must still work when the host is offline or the PR was deleted.
      let canonicalUrl = url;
      if (adding) {
        const result = await read({ environmentId, input: reference });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        canonicalUrl = result.value.url;
      }
      const link = { ...reference, url: canonicalUrl };
      const result = await update({
        environmentId,
        input: {
          threadId: threadRef.threadId,
          ...(adding ? { linkPullRequest: link } : { unlinkPullRequest: link }),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
  };
}
