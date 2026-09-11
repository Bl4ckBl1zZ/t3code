import { describe, expect, it } from "vite-plus/test";
import { parseChangeRequestUrl } from "./changeRequestUrl.ts";

describe("parseChangeRequestUrl", () => {
  it.each([
    ["https://github.com/Org/Repo/pull/12/files", "github.com", "org/repo"],
    ["https://github.corp.test/Org/Repo/pull/12", "github.corp.test", "org/repo"],
    [
      "https://code.corp.test/group/team/repo/-/merge_requests/12?x=1",
      "code.corp.test",
      "group/team/repo",
    ],
    ["https://bitbucket.org/Org/Repo/pull-requests/12", "bitbucket.org", "org/repo"],
    [
      "https://dev.azure.com/org/project/_git/repo/pullrequest/12",
      "dev.azure.com",
      "org/project/_git/repo",
    ],
    [
      "https://org.visualstudio.com/project/_git/repo/pullrequest/12",
      "org.visualstudio.com",
      "project/_git/repo",
    ],
  ])("reads a change request from %s", (url, host, repository) => {
    expect(parseChangeRequestUrl(url)).toEqual({ host, repository, number: 12 });
  });
  it.each([
    "invalid",
    "file:///org/repo/pull/12",
    "https://example.com/org/repo/pull/12",
    "https://github.com/org/repo/issues/12",
    "https://github.com/org/repo/pull/0",
    "https://github.com/org/repo/pull/9007199254740992",
    "https://github.com/org/repo/pull/12wrong",
  ])("leaves unrelated or invalid URLs unclassified: %s", (url) => {
    expect(parseChangeRequestUrl(url)).toBeNull();
  });
});
