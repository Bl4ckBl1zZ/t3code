import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, describe, it } from "@effect/vitest";

import {
  DEV_RELOAD_MANIFEST_FILE,
  resolveDefaultBrowserExtensionInstallDirs,
  syncBrowserExtensionInstall,
} from "./dev-browser-extension-sync.mjs";

describe("dev-browser-extension-sync", () => {
  it("resolves the stable macOS dev and packaged extension install folders", () => {
    assert.deepStrictEqual(
      resolveDefaultBrowserExtensionInstallDirs({
        platform: "darwin",
        homeDirectory: "/Users/alice",
      }),
      [
        "/Users/alice/Library/Application Support/t3code-dev/Chrome Extension",
        "/Users/alice/Library/Application Support/t3code/Chrome Extension",
      ],
    );
  });

  it("replaces the destination with the extension source and writes a reload manifest", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "t3-extension-sync-"));
    const sourceDir = path.join(rootDir, "source");
    const destinationDir = path.join(rootDir, "target", "Chrome Extension");
    await mkdir(path.join(sourceDir, "nested"), { recursive: true });
    await writeFile(path.join(sourceDir, "manifest.json"), "{}\n");
    await writeFile(path.join(sourceDir, "nested", "content.js"), "export {};\n");
    await mkdir(destinationDir, { recursive: true });
    await writeFile(path.join(destinationDir, "stale.txt"), "remove me");

    await syncBrowserExtensionInstall({
      sourceDir,
      destinationDirs: [destinationDir],
      token: "reload-token",
      now: new Date("2026-06-06T00:00:00.000Z"),
    });

    let staleFileExists = true;
    try {
      await stat(path.join(destinationDir, "stale.txt"));
    } catch {
      staleFileExists = false;
    }
    assert.isFalse(staleFileExists);
    assert.equal(
      await readFile(path.join(destinationDir, "nested", "content.js"), "utf8"),
      "export {};\n",
    );
    assert.deepStrictEqual(
      JSON.parse(await readFile(path.join(destinationDir, DEV_RELOAD_MANIFEST_FILE), "utf8")),
      {
        enabled: true,
        token: "reload-token",
        updatedAt: "2026-06-06T00:00:00.000Z",
      },
    );
  });
});
