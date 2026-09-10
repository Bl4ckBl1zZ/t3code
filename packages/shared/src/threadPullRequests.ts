import type { ThreadLinkedPullRequest } from "@t3tools/contracts";

type ThreadLinks = {
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  readonly linkedPullRequests?: readonly ThreadLinkedPullRequest[] | undefined;
};

/** Missing collection denotes an older projection; an empty collection explicitly clears it. */
export function linkedPullRequestsOf(thread: ThreadLinks): readonly ThreadLinkedPullRequest[] {
  return thread.linkedPullRequests ?? (thread.linkedPullRequest ? [thread.linkedPullRequest] : []);
}

export function linkedPullRequestKey(link: ThreadLinkedPullRequest): string {
  let host: string;
  try {
    host = new URL(link.url).host.toLowerCase();
  } catch {
    host = link.projectId;
  }
  return `${host}/${link.repository.toLowerCase()}#${link.number}`;
}

/** Updates are applied to the latest durable projection, so concurrent additions compose. */
export function updateLinkedPullRequests(
  thread: ThreadLinks,
  command: {
    readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
    readonly linkPullRequest?: ThreadLinkedPullRequest | undefined;
    readonly unlinkPullRequest?: ThreadLinkedPullRequest | undefined;
  },
) {
  let links = [...linkedPullRequestsOf(thread)];
  if (command.linkedPullRequest !== undefined) {
    const previous = thread.linkedPullRequest;
    if (previous)
      links = links.filter((link) => linkedPullRequestKey(link) !== linkedPullRequestKey(previous));
    if (command.linkedPullRequest) {
      links = [
        command.linkedPullRequest,
        ...links.filter(
          (link) => linkedPullRequestKey(link) !== linkedPullRequestKey(command.linkedPullRequest!),
        ),
      ];
    }
  }
  if (command.unlinkPullRequest) {
    const key = linkedPullRequestKey(command.unlinkPullRequest);
    links = links.filter((link) => linkedPullRequestKey(link) !== key);
  }
  if (command.linkPullRequest) {
    const key = linkedPullRequestKey(command.linkPullRequest);
    const existing = links.findIndex((link) => linkedPullRequestKey(link) === key);
    if (existing < 0) links.push(command.linkPullRequest);
    else links[existing] = command.linkPullRequest;
  }
  return { linkedPullRequest: links[0] ?? null, linkedPullRequests: links };
}

/** Searches every explicit link without another host request. */
export function threadPullRequestSearchTerms(thread: ThreadLinks): string[] {
  return linkedPullRequestsOf(thread).flatMap((link) => [
    `#${link.number}`,
    `${link.repository}#${link.number}`,
    link.url,
  ]);
}
