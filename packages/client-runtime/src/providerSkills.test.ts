import { describe, expect, it } from "vite-plus/test";

import {
  formatProviderSkillDisplayName,
  formatProviderSkillInstallSource,
  resolveProviderSkillSourceKind,
} from "./providerSkills.ts";

describe("formatProviderSkillDisplayName", () => {
  it("prefers the provider display name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
        displayName: "Review Follow-up",
      }),
    ).toBe("Review Follow-up");
  });

  it("falls back to a title-cased skill name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
      }),
    ).toBe("Review Follow Up");
  });
});

describe("resolveProviderSkillSourceKind", () => {
  it("marks plugin-backed skills as app installs", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
        scope: "user",
      }),
    ).toBe("app");
  });

  it("maps standard scopes to source kinds", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "repo",
      }),
    ).toBe("repo");
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "project",
      }),
    ).toBe("project");
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.agents/skills/agent-browser/SKILL.md",
        scope: "user",
      }),
    ).toBe("personal");
    expect(
      resolveProviderSkillSourceKind({
        path: "/usr/local/share/codex/skills/imagegen/SKILL.md",
        scope: "system",
      }),
    ).toBe("system");
  });

  it("keeps unknown and missing scopes usable", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
        scope: "team_shared",
      }),
    ).toBe("other");
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
      }),
    ).toBe("other");
  });
});

describe("formatProviderSkillInstallSource", () => {
  it("labels plugin-backed skills as app installs", () => {
    expect(
      formatProviderSkillInstallSource({
        path: "/home/dev/.codex/plugins/pack/skills/review/SKILL.md",
        scope: "user",
      }),
    ).toBe("App");
  });

  it("titles known scopes and falls back to the raw scope", () => {
    expect(
      formatProviderSkillInstallSource({ path: "/repo/.agents/skills/x/SKILL.md", scope: "local" }),
    ).toBe("Project");
    expect(
      formatProviderSkillInstallSource({
        path: "/opt/skills/team-review/SKILL.md",
        scope: "team_shared",
      }),
    ).toBe("Team Shared");
  });

  it("has no label when the skill carries no scope", () => {
    expect(formatProviderSkillInstallSource({ path: "/opt/skills/x/SKILL.md" })).toBe(null);
  });
});
