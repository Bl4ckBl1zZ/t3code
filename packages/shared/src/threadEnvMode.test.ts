import { describe, expect, it } from "vite-plus/test";

import {
  isDefaultThreadEnvModeSettled,
  resolveDefaultThreadEnvMode,
  resolveNewThreadEnvMode,
} from "./threadEnvMode.ts";

describe("resolveDefaultThreadEnvMode", () => {
  it("prefers the project setting over t3.json over the global default", () => {
    expect(
      resolveDefaultThreadEnvMode({
        projectSetting: "local",
        projectFile: "worktree",
        globalDefault: "worktree",
      }),
    ).toBe("local");
    expect(
      resolveDefaultThreadEnvMode({
        projectSetting: null,
        projectFile: "local",
        globalDefault: "worktree",
      }),
    ).toBe("local");
    expect(
      resolveDefaultThreadEnvMode({
        projectSetting: undefined,
        projectFile: null,
        globalDefault: "worktree",
      }),
    ).toBe("worktree");
  });
});

describe("isDefaultThreadEnvModeSettled", () => {
  it("settles on an explicit pick or project setting even while the file loads", () => {
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: "local",
        projectSetting: null,
        projectFilePending: true,
      }),
    ).toBe(true);
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: undefined,
        projectSetting: "worktree",
        projectFilePending: true,
      }),
    ).toBe(true);
  });

  it("stays unsettled only while a consulted file read is pending", () => {
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: undefined,
        projectSetting: null,
        projectFilePending: true,
      }),
    ).toBe(false);
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: undefined,
        projectSetting: null,
        projectFilePending: false,
      }),
    ).toBe(true);
  });
});

describe("resolveNewThreadEnvMode", () => {
  const newProject = {
    projectSetting: null,
    projectFile: null,
    globalDefault: "worktree" as const,
    workspaceRoot: "/data/projects/pinball-stats",
    newProjectsRoot: "/data/projects/",
    projectHasThreads: false,
  };

  it("starts a new project's first thread in its checkout", () => {
    expect(resolveNewThreadEnvMode(newProject)).toBe("local");
    expect(
      resolveNewThreadEnvMode({
        ...newProject,
        workspaceRoot: "C:\\Data\\Projects\\Pinball-Stats",
        newProjectsRoot: "c:/data/projects",
      }),
    ).toBe("local");
  });

  it("keeps the configured default once the project has a thread or is not a new project", () => {
    expect(resolveNewThreadEnvMode({ ...newProject, projectHasThreads: true })).toBe("worktree");
    expect(resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects" })).toBe(
      "worktree",
    );
    expect(
      resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects/a/nested" }),
    ).toBe("worktree");
    expect(resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects-old/a" })).toBe(
      "worktree",
    );
    expect(resolveNewThreadEnvMode({ ...newProject, newProjectsRoot: undefined })).toBe("worktree");
  });

  it("lets a project setting or a t3.json keep worktree mode", () => {
    expect(resolveNewThreadEnvMode({ ...newProject, projectSetting: "worktree" })).toBe("worktree");
    expect(resolveNewThreadEnvMode({ ...newProject, projectFile: "worktree" })).toBe("worktree");
  });
});
