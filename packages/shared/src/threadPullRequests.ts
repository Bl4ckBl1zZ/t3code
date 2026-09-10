import type { ThreadLinkedPullRequest } from "@t3tools/contracts";

/** Search terms from the V2 single-link projection, without another host request. */
export function threadPullRequestSearchTerms(thread: {
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
}): string[] {
  const link = thread.linkedPullRequest;
  return link ? [`#${link.number}`, `${link.repository}#${link.number}`, link.url] : [];
}
