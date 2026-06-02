import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  EventId,
  OrganizationId,
  OrganizationPanelSlug,
  OrganizationPanelTurnId,
  OrganizationPanelVersionId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  getOrganizationPanel,
  isValidOrganizationPanelSlug,
  resolveOrganizationPanelOrganization,
  resolveOrganizationPanelPath,
  startOrganizationPanelTurn,
} from "./organizationPanels.ts";

const testPanelSettings = {
  sidebarProjectFolders: [
    {
      id: "acme",
      name: "Acme",
      projectKeys: ["local:/work/acme"],
    },
  ],
};

it.layer(NodeServices.layer)("organization panels", (it) => {
  it("validates filesystem-safe panel slugs", () => {
    assert.isTrue(isValidOrganizationPanelSlug("acme"));
    assert.isTrue(isValidOrganizationPanelSlug("north-star-42"));
    assert.isFalse(isValidOrganizationPanelSlug("../acme"));
    assert.isFalse(isValidOrganizationPanelSlug("acme%2fpanel"));
    assert.isFalse(isValidOrganizationPanelSlug("Acme"));
    assert.isFalse(isValidOrganizationPanelSlug("acme panel"));
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
        "/state/organization-panels/acme/panel.json",
      );
      assert.strictEqual(resolved.panelFileRelativePath, "organization-panels/acme/panel.json");
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

      assert.strictEqual(snapshot.panel.panelFilePath, "organization-panels/acme/panel.json");
      assert.strictEqual(snapshot.panel.panelImportPath, "runtime:acme");
      assert.strictEqual(snapshot.panel.document.title, "Organization panel");
      assert.deepEqual(snapshot.panel.document.metrics, []);
      assert.deepEqual(snapshot.panel.document.focusItems, []);
      assert.isTrue(yield* fs.exists(path.join(stateDir, "organization-panels/acme/panel.json")));
    }),
  );

  it.effect("clears legacy starter mockup content", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "org-panel-state-" });
      const panelPath = path.join(stateDir, "organization-panels/acme/panel.json");
      yield* fs.makeDirectory(path.dirname(panelPath), { recursive: true });
      yield* fs.writeFileString(
        panelPath,
        `{"title":"Organization panel","description":"Acme has a dedicated editable panel.","metrics":[{"label":"Revenue","value":"$128K","tone":"success"},{"label":"Active users","value":"24,812","tone":"info"},{"label":"Open tickets","value":"37","tone":"warning"}],"focusItems":["Review revenue trend","Review active users trend","Review open tickets trend"]}`,
      );

      const snapshot = yield* getOrganizationPanel({
        config: { stateDir } as Parameters<typeof getOrganizationPanel>[0]["config"],
        organizationId: OrganizationId.make("acme"),
        settings: testPanelSettings,
        now: "2026-06-02T00:00:00.000Z",
      });

      assert.deepEqual(snapshot.panel.document.metrics, []);
      assert.deepEqual(snapshot.panel.document.focusItems, []);
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
      const afterContents = [
        "{",
        '  "title": "Agent edited panel",',
        '  "description": "Edited by the organization panel agent.",',
        '  "metrics": [',
        '    { "label": "Open tickets", "value": "12", "tone": "warning" }',
        "  ],",
        '  "focusItems": ["Review support queue"]',
        "}",
      ].join("\n");
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
              .writeFileString(path.join(cwd, "panel.json"), afterContents)
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
      assert.match(providerPrompt, /Update only \.\/panel\.json/u);
      assert.match(providerPrompt, /Make this an agent-edited support panel/u);
      assert.strictEqual(result.snapshot.panel.document.title, "Agent edited panel");
      assert.deepEqual(result.snapshot.panel.document.metrics, [
        { label: "Open tickets", value: "12", tone: "warning" },
      ]);
      assert.deepEqual(result.snapshot.panel.document.focusItems, ["Review support queue"]);
      assert.strictEqual(
        yield* fs.readFileString(path.join(stateDir, "organization-panels/acme/panel.json")),
        afterContents,
      );
    }),
  );
});
