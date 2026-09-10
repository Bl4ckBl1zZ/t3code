import { DEFAULT_SERVER_SETTINGS, ProjectId, type ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "./serverSettings.ts";
import {
  resolveProjectScripts,
  projectScriptsInheritDefaults,
  setupProjectScript,
  teardownProjectScript,
} from "./projectScripts.ts";

const project = {
  id: ProjectId.make("project"),
  scripts: [
    {
      id: "legacy",
      name: "Legacy",
      command: "echo legacy",
      icon: "play",
      runOnWorktreeCreate: false,
    },
  ] satisfies ProjectScript[],
};
const defaults: ProjectScript[] = [
  {
    id: "default",
    name: "Default",
    command: "echo default",
    icon: "configure",
    runOnWorktreeCreate: true,
    runOnWorktreeDelete: true,
  },
];
const settings = { ...DEFAULT_SERVER_SETTINGS, defaultProjectScripts: defaults };

describe("effective project actions", () => {
  it("preserves existing project actions and lets empty projects inherit", () => {
    expect(resolveProjectScripts(settings, project)).toEqual(project.scripts);
    expect(projectScriptsInheritDefaults(settings, project)).toBe(false);
    expect(resolveProjectScripts(settings, { ...project, scripts: [] })).toEqual(defaults);
    expect(projectScriptsInheritDefaults(settings, { ...project, scripts: [] })).toBe(true);
  });
  it("distinguishes reset-to-default from an explicitly empty list", () => {
    const inherited = applyServerSettingsPatch(settings, {
      projectScriptOverrides: { [project.id]: null },
    });
    expect(resolveProjectScripts(inherited, project)).toEqual(defaults);
    expect(projectScriptsInheritDefaults(inherited, project)).toBe(true);
    const empty = applyServerSettingsPatch(inherited, {
      projectScriptOverrides: { [project.id]: [] },
    });
    expect(resolveProjectScripts(empty, project)).toEqual([]);
    expect(projectScriptsInheritDefaults(empty, project)).toBe(false);
  });
  it("replaces one project's whole array without retaining removed actions or changing another override", () => {
    const other = ProjectId.make("other");
    const current = applyServerSettingsPatch(settings, {
      projectScriptOverrides: { [project.id]: defaults, [other]: project.scripts },
    });
    const next = applyServerSettingsPatch(current, {
      projectScriptOverrides: { [project.id]: project.scripts },
      defaultProjectScripts: [],
    });
    expect(next.projectScriptOverrides[project.id]).toEqual(project.scripts);
    expect(next.projectScriptOverrides[other]).toEqual(project.scripts);
    expect(next.defaultProjectScripts).toEqual([]);
  });
  it("uses inherited setup and fork teardown lifecycle flags", () => {
    const scripts = resolveProjectScripts(settings, { ...project, scripts: [] });
    expect(setupProjectScript(scripts)?.id).toBe("default");
    expect(teardownProjectScript(scripts)?.id).toBe("default");
  });
});
