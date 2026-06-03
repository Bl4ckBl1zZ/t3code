import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  EventId,
  OrganizationId,
  OrganizationPanelDynamicRpcMethod,
  OrganizationPanelSlug,
  OrganizationPanelTurnId,
  OrganizationPanelVersionId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  invokeOrganizationPanelDynamicRpcMethod,
  listOrganizationPanelDynamicRpcMethods,
} from "./organizationPanelDynamicRpc.ts";
import {
  ORGANIZATION_PANEL_AGENT_MODEL_SELECTION,
  getOrganizationPanel,
  isValidOrganizationPanelSlug,
  resolveOrganizationPanelOrganization,
  resolveOrganizationPanelPath,
  startOrganizationPanelTurn,
} from "./organizationPanels.ts";
import { ProcessRunner } from "./processRunner.ts";

const testPanelSettings = {
  sidebarProjectFolders: [
    {
      id: "acme",
      name: "Acme",
      projectKeys: ["local:/work/acme"],
    },
  ],
};

function testPanelHtml(input: { readonly title: string; readonly body: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${input.title}</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      body { margin: 0; font-family: system-ui, sans-serif; }
      main { width: min(100%, 64rem); margin: 0 auto; padding: 2rem; }
      @media (max-width: 640px) { main { padding: 1rem; } }
    </style>
  </head>
  <body>
    <main>${input.body}</main>
    <script>
      const main = document.querySelector("main");
      if (main) {
        main.dataset.ready = "true";
      }
    </script>
  </body>
</html>`;
}

it.layer(NodeServices.layer)("organization panels", (it) => {
  it("validates filesystem-safe panel slugs", () => {
    assert.isTrue(isValidOrganizationPanelSlug("acme"));
    assert.isTrue(isValidOrganizationPanelSlug("north-star-42"));
    assert.isFalse(isValidOrganizationPanelSlug("../acme"));
    assert.isFalse(isValidOrganizationPanelSlug("acme%2fpanel"));
    assert.isFalse(isValidOrganizationPanelSlug("Acme"));
    assert.isFalse(isValidOrganizationPanelSlug("acme panel"));
  });

  it("uses the requested stronger model selection for panel agents", () => {
    assert.deepEqual(ORGANIZATION_PANEL_AGENT_MODEL_SELECTION, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.5",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("resolves sidebar folders as organization panels", () => {
    const organization = resolveOrganizationPanelOrganization({
      organizationId: OrganizationId.make("RestoreCord Workspace"),
      settings: {
        sidebarProjectFolders: [
          {
            id: "RestoreCord Workspace",
            name: "RestoreCord",
            projectKeys: ["local:/work/restorecord"],
          },
        ],
      },
    });

    assert.isNotNull(organization);
    assert.strictEqual(organization?.name, "RestoreCord");
    assert.match(String(organization?.panelSlug), /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  });

  it.effect("resolves panel paths inside the organization folder", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveOrganizationPanelPath({
        storageRoot: "/state",
        organizationId: OrganizationId.make("acme"),
        panelSlug: OrganizationPanelSlug.make("acme"),
      });

      assert.strictEqual(
        resolved.panelFileAbsolutePath,
        "/state/organization-panels/acme/panel.html",
      );
      assert.strictEqual(resolved.panelFileRelativePath, "organization-panels/acme/panel.html");
      assert.strictEqual(resolved.panelImportPath, "runtime:acme");
    }),
  );

  it.effect("creates starter panels in the runtime state directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "org-panel-state-" });
      const snapshot = yield* getOrganizationPanel({
        config: { stateDir } as Parameters<typeof getOrganizationPanel>[0]["config"],
        organizationId: OrganizationId.make("acme"),
        settings: testPanelSettings,
        now: "2026-06-02T00:00:00.000Z",
      });

      assert.strictEqual(snapshot.panel.panelFilePath, "organization-panels/acme/panel.html");
      assert.strictEqual(snapshot.panel.panelImportPath, "runtime:acme");
      assert.strictEqual(snapshot.panel.document.title, "Organization panel");
      assert.match(snapshot.panel.document.html, /<!doctype html>/u);
      assert.match(snapshot.panel.document.html, /<meta name="viewport"/u);
      assert.isTrue(yield* fs.exists(path.join(stateDir, "organization-panels/acme/panel.html")));
    }),
  );

  it.effect("clears legacy starter mockup content", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "org-panel-state-" });
      const panelPath = path.join(stateDir, "organization-panels/acme/panel.html");
      yield* fs.makeDirectory(path.dirname(panelPath), { recursive: true });
      yield* fs.writeFileString(
        panelPath,
        testPanelHtml({
          title: "Organization panel",
          body: "<h1>Organization panel</h1><p>Acme has a dedicated editable panel.</p>",
        }),
      );

      const snapshot = yield* getOrganizationPanel({
        config: { stateDir } as Parameters<typeof getOrganizationPanel>[0]["config"],
        organizationId: OrganizationId.make("acme"),
        settings: testPanelSettings,
        now: "2026-06-02T00:00:00.000Z",
      });

      assert.notMatch(snapshot.panel.document.html, /Acme has a dedicated editable panel/u);
      assert.match(snapshot.panel.document.html, /plain HTML, CSS, and JavaScript/u);
    }),
  );

  it.effect("uses a provider agent to edit the runtime panel document", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "org-panel-state-" });
      const codexDriver = ProviderDriverKind.make("codex");
      const codexInstanceId = ProviderInstanceId.make("codex");
      const providerTurnId = TurnId.make("provider-turn-1");
      const modelSelection = {
        instanceId: codexInstanceId,
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
      };
      const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const afterContents = testPanelHtml({
        title: "Agent edited panel",
        body: '<h1>Agent edited panel</h1><p>Review support queue</p><output id="tickets">12</output>',
      });
      let sessionCwd: string | null = null;
      let providerPrompt = "";
      const providerService: Parameters<
        typeof startOrganizationPanelTurn
      >[0]["agent"]["providerService"] = {
        startSession: (_threadId, input) =>
          Effect.sync(() => {
            sessionCwd = input.cwd ?? null;
            return {
              provider: codexDriver,
              providerInstanceId: codexInstanceId,
              status: "ready",
              runtimeMode: input.runtimeMode,
              ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
              model: modelSelection.model,
              threadId: input.threadId,
              createdAt: "2026-06-02T00:00:00.000Z",
              updatedAt: "2026-06-02T00:00:00.000Z",
            };
          }),
        sendTurn: (input) =>
          Effect.gen(function* () {
            providerPrompt = input.input ?? "";
            const cwd = sessionCwd;
            if (cwd === null) {
              return yield* Effect.die(new Error("Organization panel agent session cwd missing"));
            }
            yield* fs
              .writeFileString(path.join(cwd, "panel.html"), afterContents)
              .pipe(Effect.orDie);
            yield* Queue.offer(runtimeEvents, {
              type: "turn.completed",
              eventId: EventId.make("org-panel-agent-completed"),
              provider: codexDriver,
              providerInstanceId: codexInstanceId,
              threadId: input.threadId,
              turnId: providerTurnId,
              createdAt: "2026-06-02T00:00:01.000Z",
              payload: { state: "completed" },
            } satisfies ProviderRuntimeEvent);
            return { threadId: input.threadId, turnId: providerTurnId };
          }),
        interruptTurn: () => Effect.void,
        stopSession: () => Effect.void,
        streamEvents: Stream.fromQueue(runtimeEvents),
      };

      const result = yield* startOrganizationPanelTurn({
        config: { stateDir } as Parameters<typeof startOrganizationPanelTurn>[0]["config"],
        organizationId: OrganizationId.make("acme"),
        settings: testPanelSettings,
        agent: {
          providerService,
          modelSelection,
        },
        prompt: "Make this an agent-edited support panel.",
        turnId: OrganizationPanelTurnId.make("panel-turn-1"),
        versionId: OrganizationPanelVersionId.make("panel-version-1"),
        now: "2026-06-02T00:00:00.000Z",
      });

      assert.strictEqual(sessionCwd, path.join(stateDir, "organization-panels/acme"));
      assert.match(providerPrompt, /Update \.\/panel\.html/u);
      assert.match(providerPrompt, /320px mobile width/u);
      assert.match(providerPrompt, /Match T3 Code's app style/u);
      assert.match(providerPrompt, /can be as tall as needed/u);
      assert.match(providerPrompt, /window\.t3Panel\.rpc/u);
      assert.match(providerPrompt, /Non-negotiable implementation order/u);
      assert.match(providerPrompt, /Layout contract/u);
      assert.match(providerPrompt, /Pre-made panel structures/u);
      assert.match(providerPrompt, /Structure A, browse-inspect/u);
      assert.match(providerPrompt, /Structure B, data-table/u);
      assert.match(providerPrompt, /Structure G, empty\/error\/setup/u);
      assert.match(providerPrompt, /panel-shell/u);
      assert.match(providerPrompt, /Every flex\/grid child that can contain text/u);
      assert.match(providerPrompt, /Edge-case checklist before finishing/u);
      assert.match(providerPrompt, /Make this an agent-edited support panel/u);
      assert.strictEqual(result.snapshot.panel.document.title, "Agent edited panel");
      assert.match(result.snapshot.panel.document.html, /Review support queue/u);
      assert.strictEqual(
        yield* fs.readFileString(path.join(stateDir, "organization-panels/acme/panel.html")),
        afterContents,
      );
    }),
  );

  it.effect("exposes an active panel turn while the agent is still running", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "org-panel-state-" });
      const codexDriver = ProviderDriverKind.make("codex");
      const codexInstanceId = ProviderInstanceId.make("codex");
      const providerTurnId = TurnId.make("provider-turn-active");
      const modelSelection = {
        instanceId: codexInstanceId,
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
      };
      const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const sendTurnStarted = yield* Deferred.make<void>();
      const allowCompletion = yield* Deferred.make<void>();
      let sessionCwd: string | null = null;
      const providerService: Parameters<
        typeof startOrganizationPanelTurn
      >[0]["agent"]["providerService"] = {
        startSession: (_threadId, input) =>
          Effect.sync(() => {
            sessionCwd = input.cwd ?? null;
            return {
              provider: codexDriver,
              providerInstanceId: codexInstanceId,
              status: "ready",
              runtimeMode: input.runtimeMode,
              ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
              model: modelSelection.model,
              threadId: input.threadId,
              createdAt: "2026-06-02T00:00:00.000Z",
              updatedAt: "2026-06-02T00:00:00.000Z",
            };
          }),
        sendTurn: (input) =>
          Effect.gen(function* () {
            yield* Queue.offer(runtimeEvents, {
              type: "tool.progress",
              eventId: EventId.make("org-panel-agent-progress"),
              provider: codexDriver,
              providerInstanceId: codexInstanceId,
              threadId: input.threadId,
              turnId: providerTurnId,
              createdAt: "2026-06-02T00:00:01.000Z",
              payload: {
                toolName: "edit",
                summary: "Inspecting panel requirements.",
              },
            } satisfies ProviderRuntimeEvent);
            yield* Deferred.succeed(sendTurnStarted, undefined);
            yield* Deferred.await(allowCompletion);
            const cwd = sessionCwd;
            if (cwd === null) {
              return yield* Effect.die(new Error("Organization panel agent session cwd missing"));
            }
            yield* fs
              .writeFileString(
                path.join(cwd, "panel.html"),
                testPanelHtml({
                  title: "Active turn completed",
                  body: "<h1>Active turn completed</h1>",
                }),
              )
              .pipe(Effect.orDie);
            yield* Queue.offer(runtimeEvents, {
              type: "turn.completed",
              eventId: EventId.make("org-panel-agent-active-completed"),
              provider: codexDriver,
              providerInstanceId: codexInstanceId,
              threadId: input.threadId,
              turnId: providerTurnId,
              createdAt: "2026-06-02T00:00:02.000Z",
              payload: { state: "completed" },
            } satisfies ProviderRuntimeEvent);
            return { threadId: input.threadId, turnId: providerTurnId };
          }),
        interruptTurn: () => Effect.void,
        stopSession: () => Effect.void,
        streamEvents: Stream.fromQueue(runtimeEvents),
      };

      const turnFiber = yield* startOrganizationPanelTurn({
        config: { stateDir } as Parameters<typeof startOrganizationPanelTurn>[0]["config"],
        organizationId: OrganizationId.make("acme"),
        settings: testPanelSettings,
        agent: {
          providerService,
          modelSelection,
        },
        prompt: "Keep this running while I navigate.",
        turnId: OrganizationPanelTurnId.make("panel-turn-active"),
        versionId: OrganizationPanelVersionId.make("panel-version-active"),
        now: "2026-06-02T00:00:00.000Z",
      }).pipe(Effect.forkScoped);

      yield* Deferred.await(sendTurnStarted);
      const snapshot = yield* getOrganizationPanel({
        config: { stateDir } as Parameters<typeof getOrganizationPanel>[0]["config"],
        organizationId: OrganizationId.make("acme"),
        settings: testPanelSettings,
        now: "2026-06-02T00:00:01.500Z",
      });

      assert.isNotNull(snapshot.activeTurn);
      assert.strictEqual(
        snapshot.activeTurn?.turnId,
        OrganizationPanelTurnId.make("panel-turn-active"),
      );
      assert.strictEqual(snapshot.activeTurn?.prompt, "Keep this running while I navigate.");
      assert.strictEqual(snapshot.activeTurn?.status, "running");
      assert.strictEqual(snapshot.activeTurn?.createdAt, "2026-06-02T00:00:00.000Z");
      assert.deepEqual(snapshot.activeTurn?.attachments, []);
      assert.isTrue(
        snapshot.activeTurn?.activities.some(
          (activity) => activity.message === "Inspecting panel requirements.",
        ),
      );

      yield* Deferred.succeed(allowCompletion, undefined);
      yield* Fiber.join(turnFiber);
    }),
  );

  it.effect("loads and invokes dynamic RPC command manifests", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "org-panel-state-" });
      const rpcDir = path.join(stateDir, "organization-panels/acme/rpc");
      yield* fs.makeDirectory(rpcDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(rpcDir, "issues.json"),
        `{
          "method": "organizationPanel.dynamic.github.issues.list",
          "label": "List issues",
          "params": {
            "repo": {
              "type": "string",
              "required": true,
              "pattern": "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
            }
          },
          "executor": {
            "kind": "command",
            "command": "gh",
            "args": ["issue", "list", "--repo", "\${repo}", "--json", "number,title"],
            "output": "json"
          }
        }`,
      );
      let commandArgs: readonly string[] = [];
      const processRunner = ProcessRunner.of({
        run: (input) =>
          Effect.sync(() => {
            commandArgs = input.args;
            return {
              stdout: `[{"number": 1, "title": "First"}]`,
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      });

      const methods = yield* listOrganizationPanelDynamicRpcMethods({
        config: { stateDir } as Parameters<
          typeof listOrganizationPanelDynamicRpcMethods
        >[0]["config"],
        organizationId: OrganizationId.make("acme"),
        settings: testPanelSettings,
      });
      const result = yield* invokeOrganizationPanelDynamicRpcMethod({
        config: { stateDir } as Parameters<
          typeof invokeOrganizationPanelDynamicRpcMethod
        >[0]["config"],
        organizationId: OrganizationId.make("acme"),
        settings: testPanelSettings,
        method: OrganizationPanelDynamicRpcMethod.make(
          "organizationPanel.dynamic.github.issues.list",
        ),
        payload: { repo: "restorecord/restorecord-new" },
      }).pipe(Effect.provideService(ProcessRunner, processRunner));

      assert.strictEqual(
        methods.methods[0]?.method,
        "organizationPanel.dynamic.github.issues.list",
      );
      assert.deepStrictEqual(commandArgs, [
        "issue",
        "list",
        "--repo",
        "restorecord/restorecord-new",
        "--json",
        "number,title",
      ]);
      assert.deepStrictEqual(result.result, [{ number: 1, title: "First" }]);
    }),
  );

  it.effect("lets custom dynamic RPC methods compose registered capabilities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "org-panel-state-" });
      const rpcDir = path.join(stateDir, "organization-panels/acme/rpc");
      yield* fs.makeDirectory(rpcDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(rpcDir, "issues.json"),
        `{
          "method": "organizationPanel.dynamic.github.issues.list",
          "executor": {
            "kind": "command",
            "command": "gh",
            "args": ["issue", "list", "--json", "number,title"],
            "output": "json"
          }
        }`,
      );
      yield* fs.writeFileString(
        path.join(rpcDir, "summary.json"),
        `{
          "method": "organizationPanel.dynamic.github.issues.summary",
          "executor": {
            "kind": "custom",
            "source": "const issues = await ctx.rpc('organizationPanel.dynamic.github.issues.list', {}); return { open: issues.length, firstTitle: issues[0]?.title ?? null };"
          }
        }`,
      );
      const processRunner = ProcessRunner.of({
        run: () =>
          Effect.succeed({
            stdout: `[{"number": 1, "title": "First"}]`,
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      });

      const result = yield* invokeOrganizationPanelDynamicRpcMethod({
        config: { stateDir } as Parameters<
          typeof invokeOrganizationPanelDynamicRpcMethod
        >[0]["config"],
        organizationId: OrganizationId.make("acme"),
        settings: testPanelSettings,
        method: OrganizationPanelDynamicRpcMethod.make(
          "organizationPanel.dynamic.github.issues.summary",
        ),
        payload: {},
      }).pipe(Effect.provideService(ProcessRunner, processRunner));

      assert.deepStrictEqual(result.result, { open: 1, firstTitle: "First" });
    }),
  );
});
