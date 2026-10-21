import { shortcutLabelForCommand } from "./keybindings";
import { describe, expect, it } from "vite-plus/test";
import {
  projectScriptMenuLabel,
  runningSingleRunScriptIds,
  settleProjectScript,
  singleRunScriptTerminalId,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";

import {
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  releaseClaimedRoles,
} from "./projectScripts";

describe("projectScripts helpers", () => {
  it.each(["install-javascript-dependencies", "A", "a.b", "a b", "-a", "", "a".repeat(25)])(
    "omits the shortcut for legacy script ID %j without crashing script menus",
    (id) => {
      const commands = ["lint", id, "test"].map(commandForProjectScript);
      expect(commands).toEqual(["script.lint.run", null, "script.test.run"]);
      expect(commands.map((command) => shortcutLabelForCommand([], command))).toEqual([
        null,
        null,
        null,
      ]);
    },
  );

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("resolves primary, setup, and settle scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "clean",
        name: "Clean",
        command: "cargo clean",
        icon: "build" as const,
        runOnWorktreeCreate: false,
        runOnSettle: true,
      },
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test" as const,
        runOnWorktreeCreate: false,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("test");
    expect(setupProjectScript(scripts)?.id).toBe("setup");
    expect(settleProjectScript(scripts)?.id).toBe("clean");
    expect(primaryProjectScript(scripts.filter((script) => script.id === "clean"))).toBeNull();
  });

  it("moves the setup and settle roles to the script that claims them", () => {
    const input = {
      name: "Next",
      command: "true",
      icon: "play",
      waitForSetup: false,
      previewUrl: null,
      autoOpenPreview: false,
      runOnWorktreeDelete: false,
      singleRun: false,
    } as const;
    const holder = {
      id: "holder",
      name: "Holder",
      command: "true",
      icon: "play" as const,
      runOnWorktreeCreate: true,
      runOnSettle: true,
    };

    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: false, runOnSettle: true }),
    ).toMatchObject({ runOnWorktreeCreate: true, runOnSettle: false });
    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: true, runOnSettle: false }),
    ).toMatchObject({ runOnWorktreeCreate: false, runOnSettle: true });
    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: false, runOnSettle: false }),
    ).toBe(holder);
    expect(
      releaseClaimedRoles(
        { ...holder, runOnWorktreeDelete: true },
        { ...input, runOnWorktreeCreate: false, runOnSettle: false, runOnWorktreeDelete: true },
      ),
    ).toMatchObject({ runOnWorktreeCreate: true, runOnSettle: true, runOnWorktreeDelete: false });
  });

  it("reports a single-run script as running only while its own terminal runs a command", () => {
    const base = { command: "pnpm dev", icon: "play" as const, runOnWorktreeCreate: false };
    const scripts = [
      { ...base, id: "dev", name: "Dev", singleRun: true },
      { ...base, id: "test", name: "Test" },
    ];
    expect(singleRunScriptTerminalId("dev")).toBe("script-dev");
    expect([...runningSingleRunScriptIds(scripts, ["script-dev", "script-test"])]).toEqual(["dev"]);
    expect(runningSingleRunScriptIds(scripts, ["term-1"]).size).toBe(0);
    expect(projectScriptMenuLabel(scripts[0]!, { running: true })).toBe("Dev (running)");
  });

  it("never picks a teardown-only script as the primary action", () => {
    const base = { command: "true", icon: "play" as const, runOnWorktreeCreate: false };
    expect(
      primaryProjectScript([
        { ...base, id: "down", name: "Down", runOnWorktreeDelete: true },
        { ...base, id: "dev", name: "Dev" },
      ])?.id,
    ).toBe("dev");
  });
});
