import type {
  ProjectId,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
  ThreadPullRequestLinkSource,
  ThreadPullRequestSnapshot,
  ThreadPullRequestStack,
} from "@t3tools/contracts";
import {
  legacyThreadPullRequestKey,
  threadPullRequestKeyOf,
  resolveThreadCurrentPullRequestLink,
  visibleThreadPullRequests,
} from "./threadPullRequestChains.ts";

type ThreadLinks = {
  readonly projectId?: ProjectId | undefined;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  readonly linkedPullRequests?: readonly ThreadLinkedPullRequest[] | undefined;
  readonly pullRequests?: readonly ThreadPullRequestLink[] | undefined;
};

const LEGACY_LINKED_AT = "1970-01-01T00:00:00.000Z";

/** An absent collection is an older projection; an empty collection explicitly clears it. */
export function allThreadPullRequestsOf(thread: ThreadLinks): readonly ThreadPullRequestLink[] {
  return (
    thread.pullRequests ??
    (thread.linkedPullRequests ?? (thread.linkedPullRequest ? [thread.linkedPullRequest] : [])).map(
      (link) => ({
        ...legacyThreadPullRequestKey(link),
        projectId: link.projectId,
        url: link.url,
        source: "manual",
        linkedAt: LEGACY_LINKED_AT,
        snapshot: null,
        stack: null,
      }),
    )
  );
}

function legacyLink(
  link: ThreadPullRequestLink,
  projectId: ProjectId | undefined,
): ThreadLinkedPullRequest | null {
  const owner = link.projectId ?? projectId;
  const repository =
    link.host === "dev.azure.com"
      ? (link.repository.split("/_git/").at(-1) ?? link.repository)
      : link.repository;
  return owner ? { projectId: owner, repository, number: link.number, url: link.url } : null;
}

export function linkedPullRequestsOf(thread: ThreadLinks): readonly ThreadLinkedPullRequest[] {
  if (thread.pullRequests === undefined)
    return (
      thread.linkedPullRequests ?? (thread.linkedPullRequest ? [thread.linkedPullRequest] : [])
    );
  return visibleThreadPullRequests(thread.pullRequests).flatMap((link) => {
    const legacy = legacyLink(link, thread.projectId);
    return legacy ? [legacy] : [];
  });
}

export function linkedPullRequestKey(link: ThreadLinkedPullRequest): string {
  return threadPullRequestKeyOf(legacyThreadPullRequestKey(link));
}

/** Atomic edits apply to the latest projection; a background sync cannot recreate a removed link. */
export function updateLinkedPullRequests(
  thread: ThreadLinks,
  command: {
    readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
    readonly linkPullRequest?: ThreadLinkedPullRequest | undefined;
    readonly unlinkPullRequest?: ThreadLinkedPullRequest | undefined;
    readonly linkPullRequestSource?: ThreadPullRequestLinkSource | undefined;
    readonly syncPullRequest?:
      | {
          readonly reference: ThreadPullRequestLink;
          readonly snapshot: ThreadPullRequestSnapshot;
          readonly stack: ThreadPullRequestStack | null;
        }
      | undefined;
  },
  now = LEGACY_LINKED_AT,
) {
  let links = [...allThreadPullRequestsOf(thread)];
  const remove = (reference: ThreadLinkedPullRequest) => {
    const key = linkedPullRequestKey(reference);
    const existing = links.find((link) => threadPullRequestKeyOf(link) === key);
    const belongsToStack =
      existing &&
      (existing.source === "stack" ||
        existing.source === "stack-dismissed" ||
        existing.stack !== null ||
        links.some(
          (link) =>
            link.host.toLowerCase() === existing.host.toLowerCase() &&
            link.repository.toLowerCase() === existing.repository.toLowerCase() &&
            link.stack?.layers.some((layer) => layer.number === existing.number),
        ));
    links = links.flatMap((link) =>
      threadPullRequestKeyOf(link) !== key
        ? [link]
        : belongsToStack
          ? [{ ...link, source: "stack-dismissed" as const }]
          : [],
    );
  };
  const add = (
    reference: ThreadLinkedPullRequest,
    source: ThreadPullRequestLinkSource,
    first = false,
  ) => {
    const key = linkedPullRequestKey(reference);
    const index = links.findIndex((link) => threadPullRequestKeyOf(link) === key);
    const existing = index < 0 ? undefined : links[index];
    // Automatic stack discovery never revives a tombstone or downgrades an explicit link.
    if (
      existing &&
      (existing.source !== "stack-dismissed" || source === "stack" || source === "stack-dismissed")
    )
      return;
    const next: ThreadPullRequestLink = {
      ...legacyThreadPullRequestKey(reference),
      projectId: reference.projectId,
      url: reference.url,
      source,
      linkedAt: existing?.source === source ? existing.linkedAt : now,
      snapshot: existing?.snapshot ?? null,
      stack: existing?.stack ?? null,
    };
    if (first) links = [next, ...links.filter((link) => threadPullRequestKeyOf(link) !== key)];
    else if (index < 0) links.push(next);
    else links[index] = next;
  };
  if (command.linkedPullRequest !== undefined) {
    if (thread.linkedPullRequest) remove(thread.linkedPullRequest);
    if (command.linkedPullRequest) add(command.linkedPullRequest, "manual", true);
  }
  if (command.unlinkPullRequest) remove(command.unlinkPullRequest);
  if (command.linkPullRequest)
    add(command.linkPullRequest, command.linkPullRequestSource ?? "manual");
  if (command.syncPullRequest) {
    const { reference, snapshot, stack } = command.syncPullRequest;
    const index = links.findIndex(
      (link) => threadPullRequestKeyOf(link) === threadPullRequestKeyOf(reference),
    );
    const current = index < 0 ? undefined : links[index];
    if (
      current &&
      current.source !== "stack-dismissed" &&
      current.source === reference.source &&
      current.linkedAt === reference.linkedAt &&
      current.url === reference.url
    ) {
      links[index] = { ...current, snapshot, stack };
    }
  }
  const current = resolveThreadCurrentPullRequestLink(links);
  return {
    pullRequests: links,
    linkedPullRequest: current ? legacyLink(current, thread.projectId) : null,
    linkedPullRequests: linkedPullRequestsOf({ ...thread, pullRequests: links }),
  };
}

/** Search every visible link, including cached host titles, without another host request. */
export function threadPullRequestSearchTerms(thread: ThreadLinks): string[] {
  return visibleThreadPullRequests(allThreadPullRequestsOf(thread)).flatMap((link) => [
    `#${link.number}`,
    `${link.repository}#${link.number}`,
    link.url,
    link.snapshot?.title ?? "",
  ]);
}
