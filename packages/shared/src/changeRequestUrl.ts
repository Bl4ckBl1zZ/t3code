import { canonicalRepositoryKey } from "./sourceControl.ts";

export function changeRequestUrlFor(
  kind: string | null | undefined,
  host: string,
  repository: string,
  number: number,
): string | null {
  switch (kind) {
    case "github":
      return `https://${host}/${repository}/pull/${number}`;
    case "gitlab":
      return `https://${host}/${repository}/-/merge_requests/${number}`;
    case "bitbucket":
      return `https://${host}/${repository}/pull-requests/${number}`;
    case "azure-devops":
      return `https://${canonicalRepositoryKey(`${host}/${repository}`.toLowerCase())}/pullrequest/${number}`;
    default:
      return null;
  }
}
