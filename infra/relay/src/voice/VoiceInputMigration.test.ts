import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

const migrationUrl = new URL(
  "../../migrations/postgres/20260731110708_add_voice_input/migration.sql",
  import.meta.url,
);

it.layer(NodeServices.layer)("relay Voice Input migration", (it) => {
  it.effect("creates every table used by Voice Input persistence", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationPath = yield* path.fromFileUrl(migrationUrl);
      const migration = yield* fileSystem.readFileString(migrationPath);

      expect(migration).toContain('CREATE TABLE "relay_account_integrations"');
      expect(migration).toContain('CREATE TABLE "relay_voice_input_settings"');
      expect(migration).toContain('CREATE TABLE "relay_voice_transcription_requests"');
    }),
  );
});
