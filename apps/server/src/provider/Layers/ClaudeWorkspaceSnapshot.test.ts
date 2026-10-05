import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { vi } from "vite-plus/test";
import {
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { probeClaudeWorkspaceSnapshot } from "./ClaudeProvider.ts";
import { COMPACT_SLASH_COMMAND } from "../providerSnapshot.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const machineSnapshot = {
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated", email: "machine@example.com" },
  checkedAt: "2026-03-25T00:00:00.000Z",
  version: "2.1.288",
  models: [],
  slashCommands: [{ name: "server-cwd-only" }],
  skills: [],
} satisfies ServerProvider;

const writeProjectSkill = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const skillDir = path.join(cwd, ".claude", "skills", "existing-skill");
    yield* fs.makeDirectory(skillDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(skillDir, "SKILL.md"),
      "---\nname: existing-skill\ndescription: Existing project skill\n---\nUse this skill.",
    );
    return path.join(skillDir, "SKILL.md");
  });

it.layer(NodeServices.layer)("Claude workspace snapshot", (it) => {
  it.effect(
    "discovers commands and skills separately for each cwd without replacing machine metadata",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-workspaces-" });
        const configDir = path.join(tempDir, "claude-home");
        const workspaces = [path.join(tempDir, "one"), path.join(tempDir, "two")];
        for (const cwd of workspaces) yield* writeProjectSkill(cwd);
        let usageCalls = 0;
        const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
          assert.equal(options?.env?.CLAUDE_CONFIG_DIR, configDir);
          assert.equal(options?.env?.T3_WORKSPACE_PROBE, "owned-instance");
          return {
            initializationResult: async () => ({
              account: { email: "workspace@example.com" },
              commands: [
                {
                  name: options?.cwd === workspaces[0] ? "start-session" : "other-project",
                  description: "Project command",
                  argumentHint: "[topic]",
                },
                { name: "nested:review", description: "Review changes", argumentHint: "" },
                { name: "NESTED:review", description: "", argumentHint: "[path]" },
                { name: "compact", description: "Provider compact", argumentHint: "" },
                { name: "user-command", description: "Existing user command", argumentHint: "" },
              ],
            }),
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
              usageCalls++;
              return { rate_limits_available: false, rate_limits: null };
            },
          } as unknown as ReturnType<typeof ClaudeSdk.query>;
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
        for (const [index, cwd] of workspaces.entries()) {
          const scoped = yield* probeClaudeWorkspaceSnapshot(
            decodeClaudeSettings({ homePath: configDir }),
            machineSnapshot,
            cwd,
            { ...process.env, T3_WORKSPACE_PROBE: "owned-instance" },
          );
          assert.deepEqual(scoped, {
            ...machineSnapshot,
            slashCommandsPending: false,
            slashCommands: [
              COMPACT_SLASH_COMMAND,
              {
                name: index === 0 ? "start-session" : "other-project",
                description: "Project command",
                input: { hint: "[topic]" },
              },
              { name: "nested:review", description: "Review changes", input: { hint: "[path]" } },
              { name: "user-command", description: "Existing user command" },
            ],
            skills: [
              {
                name: "existing-skill",
                path: path.join(cwd, ".claude", "skills", "existing-skill", "SKILL.md"),
                enabled: true,
                scope: "project",
                description: "Existing project skill",
              },
            ],
          });
        }
        assert.deepEqual(
          query.mock.calls.map(([input]) => input.options?.cwd),
          workspaces,
        );
        // Usage belongs to the machine probe; a workspace scan never asks for it.
        assert.equal(usageCalls, 0);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps readable skills during failed command discovery and recovers on retry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-workspace-retry-" });
      const skillPath = yield* writeProjectSkill(cwd);
      const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(
        () =>
          ({
            initializationResult: () =>
              Promise.reject<ClaudeSdk.SDKControlInitializeResponse>(
                new Error("Initialization failed"),
              ),
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
              rate_limits_available: false,
              rate_limits: null,
            }),
          }) as unknown as ReturnType<typeof ClaudeSdk.query>,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
      const settings = decodeClaudeSettings({ homePath: cwd });
      const failed = yield* probeClaudeWorkspaceSnapshot(settings, machineSnapshot, cwd);
      assert.deepEqual(failed, {
        ...machineSnapshot,
        slashCommands: [COMPACT_SLASH_COMMAND],
        slashCommandsPending: true,
        skills: [
          {
            name: "existing-skill",
            path: skillPath,
            enabled: true,
            scope: "project",
            description: "Existing project skill",
          },
        ],
      });
      query.mockImplementation(
        () =>
          ({
            initializationResult: async () => ({
              commands: [{ name: "recovered", description: "", argumentHint: "" }],
            }),
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
              rate_limits_available: false,
              rate_limits: null,
            }),
          }) as unknown as ReturnType<typeof ClaudeSdk.query>,
      );
      const recovered = yield* probeClaudeWorkspaceSnapshot(settings, machineSnapshot, cwd);
      assert.deepEqual(recovered.slashCommands, [COMPACT_SLASH_COMMAND, { name: "recovered" }]);
      assert.equal(recovered.status, "ready");
      assert.equal(recovered.slashCommandsPending, false);
      assert.deepEqual(recovered.skills, failed.skills);
      const disabled = yield* probeClaudeWorkspaceSnapshot(
        { ...settings, enabled: false },
        machineSnapshot,
        cwd,
      );
      assert.equal(disabled, machineSnapshot);
      assert.equal(query.mock.calls.length, 2);
    }).pipe(Effect.scoped),
  );
});
