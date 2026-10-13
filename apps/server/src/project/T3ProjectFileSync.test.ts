import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, type ProjectScript } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import * as T3ProjectFileSync from "./T3ProjectFileSync.ts";

const projectId = ProjectId.make("project:sync");

const dev: ProjectScript = {
  id: "dev",
  name: "Dev",
  command: "vp dev",
  icon: "play",
  runOnWorktreeCreate: false,
};

const harness = (initialScripts?: ReadonlyArray<ProjectScript>, env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-json-sync-" });
    const project = {
      id: projectId,
      title: "Project",
      workspaceRoot: root,
      repositoryIdentity: null,
      faviconPath: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
      deletedAt: null,
    };
    const context = yield* Layer.build(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          snapshot: Effect.succeed({
            projects: [project],
            updatedAt: "2026-06-20T00:00:00.000Z",
          }),
        }),
        ServerSettings.layerTest({
          projectSettingsFolded: true,
          ...(initialScripts
            ? {
                projectSettingsOverrides: {
                  [projectId]: { defaultProjectScripts: initialScripts },
                },
              }
            : {}),
        }),
        ServerConfig.layerTest(root, { prefix: "t3-json-sync-home-" }),
      ),
    );
    const makeSync = T3ProjectFileSync.make.pipe(
      Effect.provide(context),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    );
    const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(context));
    const settings = yield* ServerSettings.ServerSettingsService.pipe(Effect.provide(context));
    const filePath = `${root}/t3.json`;
    const ownScripts = settings.getSettings.pipe(
      Effect.map((current) => current.projectSettingsOverrides[projectId]?.defaultProjectScripts),
    );
    const setOwnScripts = (scripts: ReadonlyArray<ProjectScript>) =>
      settings.updateSettings({
        projectSettingsOverrides: { [projectId]: { defaultProjectScripts: scripts } },
      });
    const writeFile = (contents: string) => fs.writeFileString(filePath, contents);
    const readFile = fs.readFileString(filePath).pipe(Effect.map((text) => JSON.parse(text)));
    return { fs, config, makeSync, filePath, ownScripts, setOwnScripts, writeFile, readFile };
  });

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("T3ProjectFileSync", () => {
  it.live("writes in-app edits back, keeping async and every field it does not own", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness([dev]);
        yield* h.writeFile(
          JSON.stringify({
            $schema: "https://mirror.example/t3.json",
            iconPath: "logo.svg",
            futureField: { keep: true },
            scripts: [
              {
                name: "Dev",
                command: "vp dev",
                icon: "play",
                customKey: "kept",
              },
            ],
          }),
        );
        const sync = yield* h.makeSync;
        yield* sync.syncNow;
        yield* h.setOwnScripts([
          { ...dev, command: "vp dev --host" },
          {
            id: "setup",
            name: "Setup",
            command: "vp i",
            icon: "configure",
            runOnWorktreeCreate: true,
            async: false,
            singleRun: true,
            runOnWorktreeDelete: true,
          },
        ]);
        yield* sync.syncNow;

        const file = yield* h.readFile;
        assert.equal(file.$schema, "https://mirror.example/t3.json");
        assert.equal(file.iconPath, "logo.svg");
        assert.deepEqual(file.futureField, { keep: true });
        assert.deepEqual(file.scripts, [
          { name: "Dev", command: "vp dev --host", icon: "play", customKey: "kept" },
          {
            name: "Setup",
            command: "vp i",
            icon: "configure",
            runOnWorktreeCreate: true,
            runOnWorktreeDelete: true,
            singleRun: true,
            async: false,
          },
        ]);
      }),
    ),
  );

  it.live("applies a t3.json edit to the project's actions, keeping ids by name", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness([dev]);
        const sync = yield* h.makeSync;
        yield* sync.syncNow;
        yield* h.writeFile(
          JSON.stringify({
            scripts: [
              { name: "Dev", command: "vp dev --open", async: true },
              { name: "Lint", command: "vp lint", icon: "lint" },
            ],
          }),
        );
        yield* sync.syncNow;
        assert.deepEqual(yield* h.ownScripts, [
          {
            id: "dev",
            name: "Dev",
            command: "vp dev --open",
            icon: "play",
            runOnWorktreeCreate: false,
            async: true,
          },
          {
            id: "lint",
            name: "Lint",
            command: "vp lint",
            icon: "lint",
            runOnWorktreeCreate: false,
          },
        ]);
      }),
    ),
  );

  it.live("leaves t3.json to the manual import until the project has its own actions", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.writeFile(`{
          // comments are fine
          "scripts": [{ "name": "Test", "command": "vp test", }],
        }`);
        const sync = yield* h.makeSync;
        yield* sync.syncNow;
        assert.equal(yield* h.ownScripts, undefined);

        // Importing gives the project its own list, which the file then mirrors.
        yield* h.setOwnScripts([{ ...dev, id: "test", name: "Test", command: "vp test" }, dev]);
        yield* sync.syncNow;
        assert.deepEqual(
          (yield* h.readFile).scripts.map((script: { command: string }) => script.command),
          ["vp test", "vp dev"],
        );
      }),
    ),
  );

  it.live("never drops file scripts the project did not import", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness();
        const a = { name: "A", command: "run a" };
        const b = { name: "B", command: "run b", team: "only" };
        yield* h.writeFile(JSON.stringify({ scripts: [a, b] }));
        const sync = yield* h.makeSync;
        yield* sync.syncNow;

        // Import only A, then edit it in the app.
        const imported = { ...dev, id: "a", name: "A", command: "run a" };
        yield* h.setOwnScripts([imported]);
        yield* sync.syncNow;
        yield* h.setOwnScripts([{ ...imported, command: "run a --fast" }]);
        yield* sync.syncNow;
        assert.deepEqual((yield* h.readFile).scripts, [
          { name: "A", command: "run a --fast", icon: "play" },
          b,
        ]);

        // A real deletion removes A from the file; B stays.
        yield* h.setOwnScripts([]);
        yield* sync.syncNow;
        assert.deepEqual((yield* h.readFile).scripts, [b]);
      }),
    ),
  );

  it.live("adds scripts new to the file and deletes ones removed from it, ignoring the rest", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness([{ ...dev, id: "a", name: "A", command: "run a" }]);
        yield* h.writeFile(
          JSON.stringify({
            scripts: [
              { name: "A", command: "run a" },
              { name: "B", command: "run b" },
            ],
          }),
        );
        const sync = yield* h.makeSync;
        yield* sync.syncNow;
        assert.deepEqual(
          (yield* h.ownScripts)?.map((script) => script.name),
          ["A"],
        );

        yield* h.writeFile(
          JSON.stringify({
            scripts: [
              { name: "B", command: "run b --changed" },
              { name: "C", command: "run c" },
            ],
          }),
        );
        yield* sync.syncNow;
        assert.deepEqual(
          (yield* h.ownScripts)?.map((script) => `${script.id}:${script.command}`),
          ["c:run c"],
        );
      }),
    ),
  );

  it.live("leaves an invalid t3.json and the project's actions alone", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness([dev]);
        yield* h.writeFile(`{ "scripts": [{ "name": "Broken" }] }`);
        const sync = yield* h.makeSync;
        yield* sync.syncNow;
        yield* h.setOwnScripts([{ ...dev, name: "Renamed" }]);
        yield* sync.syncNow;
        assert.equal(
          yield* h.fs.readFileString(h.filePath),
          `{ "scripts": [{ "name": "Broken" }] }`,
        );
        assert.equal((yield* h.ownScripts)?.[0]?.name, "Renamed");
      }),
    ),
  );

  it.live("points a new t3.json at the configured relay's schema", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness([dev], { T3CODE_RELAY_URL: "https://relay.example.test" });
        yield* (yield* h.makeSync).syncNow;
        assert.equal((yield* h.readFile).$schema, "https://relay.example.test/schema/t3.json");
      }),
    ),
  );

  it.live("skips the backfill the fork already ran", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness([dev]);
        yield* h.fs.makeDirectory(h.config.stateDir, { recursive: true });
        yield* h.fs.writeFileString(
          h.config.settingsPath,
          JSON.stringify({ projectFileBackfillApplied: true }),
        );
        yield* (yield* h.makeSync).syncNow;
        assert.equal(yield* h.fs.exists(h.filePath), false);

        // Recorded in this build's marker, so it holds once the fork key is gone.
        yield* h.fs.remove(h.config.settingsPath);
        yield* (yield* h.makeSync).syncNow;
        assert.equal(yield* h.fs.exists(h.filePath), false);
      }),
    ),
  );

  it.live("backfills t3.json once, then respects its deletion", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness([dev]);
        yield* (yield* h.makeSync).syncNow;
        const file = yield* h.readFile;
        assert.equal(file.$schema, "https://t3.codes/schema/t3.json");
        assert.deepEqual(file.scripts, [{ name: "Dev", command: "vp dev", icon: "play" }]);

        yield* h.fs.remove(h.filePath);
        yield* (yield* h.makeSync).syncNow;
        assert.equal(yield* h.fs.exists(h.filePath), false);
      }),
    ),
  );
});
