import { describe, expect, it } from "vite-plus/test";
import { resolveLinkPullRequestInput, changeRequestWebUrl } from "./LinkPullRequestDialog";
const project = {
  host: "github.com",
  repository: "team/repo",
  webUrl: (number: number) => changeRequestWebUrl("github", "github.com", "team/repo", number),
};
describe("PR link resolution", () => {
  it("resolves bare numbers against the thread's own repository", () => {
    expect(
      resolveLinkPullRequestInput({ reference: "#42", project, hasProject: () => true }),
    ).toEqual({
      link: {
        host: "github.com",
        repository: "team/repo",
        number: 42,
        url: "https://github.com/team/repo/pull/42",
      },
    });
  });
  it("requires a readable project for a URL instead of guessing credentials", () => {
    expect(
      resolveLinkPullRequestInput({
        reference: "https://github.com/other/repo/pull/7",
        project,
        hasProject: () => false,
      }),
    ).toHaveProperty("error");
  });
  it("rejects zero, malformed and unsafe references", () => {
    for (const reference of ["0", "-1", "9007199254740992", "javascript:alert(1)", "not a PR"])
      expect(
        resolveLinkPullRequestInput({ reference, project, hasProject: () => true }),
      ).toBeNull();
  });
  it("constructs Azure URLs from SSH and legacy remotes", () => {
    expect(changeRequestWebUrl("azure-devops", "ssh.dev.azure.com", "v3/Org/Project/Repo", 7)).toBe(
      "https://dev.azure.com/org/project/_git/repo/pullrequest/7",
    );
    expect(
      changeRequestWebUrl("azure-devops", "org.visualstudio.com", "project/_git/repo", 7),
    ).toBe("https://dev.azure.com/org/project/_git/repo/pullrequest/7");
  });
});
