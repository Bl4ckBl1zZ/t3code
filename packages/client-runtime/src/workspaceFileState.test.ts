import {
  EnvironmentId,
  type WorkspaceEntry,
  type WorkspaceFileChangeEvent,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkspaceDocumentManager,
  type WorkspaceDocumentClient,
} from "./workspaceDocumentState.ts";
import { createWorkspaceTreeManager, type WorkspaceTreeClient } from "./workspaceTreeState.ts";

let registry = AtomRegistry.make();

function resetRegistry() {
  registry.dispose();
  registry = AtomRegistry.make();
}

const ENVIRONMENT_ID = EnvironmentId.make("env-local");
const TARGET = {
  environmentId: ENVIRONMENT_ID,
  cwd: "/repo",
  relativePath: "src",
} as const;
const FILE_TARGET = {
  environmentId: ENVIRONMENT_ID,
  cwd: "/repo",
  relativePath: "src/index.ts",
} as const;

function unresolvedDirectoryResult(): ReturnType<typeof directoryResult> {
  throw new Error("Directory resolver was not initialized.");
}

const textEntry = (relativePath: string): WorkspaceEntry => ({
  relativePath,
  name: relativePath.split("/").pop() ?? relativePath,
  kind: "file",
  parentPath: relativePath.includes("/")
    ? relativePath.split("/").slice(0, -1).join("/")
    : undefined,
  sizeBytes: 1,
  mtimeMs: 1,
  readonly: false,
  hidden: false,
  ignored: false,
});

function directoryResult(relativePath: string, entries: WorkspaceEntry[] = []) {
  return {
    cwd: "/repo",
    relativePath,
    entries,
    truncated: false,
    scannedAt: "2026-01-01T00:00:00.000Z",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetRegistry();
});

describe("createWorkspaceTreeManager", () => {
  it("dedupes in-flight loads and reuses fresh cached entries", async () => {
    let resolveList: (result: ReturnType<typeof directoryResult>) => void =
      unresolvedDirectoryResult;
    const client = {
      listDirectory: vi.fn(
        () =>
          new Promise<ReturnType<typeof directoryResult>>((resolve) => {
            resolveList = resolve;
          }),
      ),
    } satisfies WorkspaceTreeClient;
    const manager = createWorkspaceTreeManager({
      getRegistry: () => registry,
      getClient: () => client,
    });

    const first = manager.refresh(TARGET);
    const second = manager.refresh(TARGET);

    expect(first).toBe(second);
    expect(client.listDirectory).toHaveBeenCalledOnce();

    resolveList(directoryResult("src", [textEntry("src/index.ts")]));
    await first;
    await manager.refresh(TARGET);

    expect(client.listDirectory).toHaveBeenCalledOnce();
    expect(manager.getSnapshot(TARGET).data?.entries[0]?.relativePath).toBe("src/index.ts");
  });

  it("refreshes watched directories after matching change events", async () => {
    const listeners = new Set<(event: WorkspaceFileChangeEvent) => void>();
    const client = {
      listDirectory: vi
        .fn()
        .mockResolvedValueOnce(directoryResult("src", [textEntry("src/a.ts")]))
        .mockResolvedValueOnce(directoryResult("src", [textEntry("src/b.ts")])),
      subscribeChanges: vi.fn((_input, nextListener) => {
        listeners.add(nextListener);
        return () => listeners.delete(nextListener);
      }),
    } satisfies WorkspaceTreeClient;
    const manager = createWorkspaceTreeManager({
      getRegistry: () => registry,
      getClient: () => client,
    });

    await manager.refresh(TARGET);
    manager.watch(TARGET);
    expect(manager.getSnapshot(TARGET).data?.entries[0]?.relativePath).toBe("src/a.ts");

    for (const listener of listeners) {
      listener({
        cwd: "/repo",
        relativePath: "src/b.ts",
        kind: "updated",
        directoryPath: "src",
        observedAt: "2026-01-01T00:00:01.000Z",
      });
    }
    await Promise.resolve();

    expect(client.listDirectory).toHaveBeenCalledTimes(2);
    expect(manager.getSnapshot(TARGET).data?.entries[0]?.relativePath).toBe("src/b.ts");
  });

  it("reuses latest directory listing options for automatic refreshes", async () => {
    const listeners = new Set<(event: WorkspaceFileChangeEvent) => void>();
    const client = {
      listDirectory: vi.fn(async () => directoryResult("src", [textEntry("src/a.ts")])),
      subscribeChanges: vi.fn((_input, nextListener) => {
        listeners.add(nextListener);
        return () => listeners.delete(nextListener);
      }),
    } satisfies WorkspaceTreeClient;
    const manager = createWorkspaceTreeManager({
      getRegistry: () => registry,
      getClient: () => client,
    });

    await manager.refresh(TARGET, { includeHidden: true, includeIgnored: true, limit: 42 });
    manager.watch(TARGET);

    for (const listener of listeners) {
      listener({
        cwd: "/repo",
        relativePath: "src/.env",
        kind: "updated",
        directoryPath: "src",
        observedAt: "2026-01-01T00:00:01.000Z",
      });
    }
    await Promise.resolve();

    expect(client.listDirectory).toHaveBeenLastCalledWith({
      cwd: "/repo",
      relativePath: "src",
      includeHidden: true,
      includeIgnored: true,
      limit: 42,
    });
  });

  it("applies optimistic create, rename, and delete results", async () => {
    const client = {
      listDirectory: vi.fn(async () => directoryResult("src", [textEntry("src/a.ts")])),
    } satisfies WorkspaceTreeClient;
    const manager = createWorkspaceTreeManager({
      getRegistry: () => registry,
      getClient: () => client,
    });
    await manager.refresh(TARGET);

    manager.applyCreateResult(ENVIRONMENT_ID, {
      cwd: "/repo",
      relativePath: "src/b.ts",
      entry: textEntry("src/b.ts"),
      changedAt: "2026-01-01T00:00:01.000Z",
    });
    expect(manager.getSnapshot(TARGET).data?.entries.map((entry) => entry.relativePath)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);

    manager.applyRenameResult(ENVIRONMENT_ID, {
      cwd: "/repo",
      fromRelativePath: "src/a.ts",
      toRelativePath: "src/c.ts",
      entry: textEntry("src/c.ts"),
      changedAt: "2026-01-01T00:00:02.000Z",
    });
    expect(manager.getSnapshot(TARGET).data?.entries.map((entry) => entry.relativePath)).toEqual([
      "src/b.ts",
      "src/c.ts",
    ]);

    manager.applyDeleteResult(ENVIRONMENT_ID, {
      cwd: "/repo",
      relativePath: "src/b.ts",
      changedAt: "2026-01-01T00:00:03.000Z",
    });
    expect(manager.getSnapshot(TARGET).data?.entries.map((entry) => entry.relativePath)).toEqual([
      "src/c.ts",
    ]);
  });
});

describe("createWorkspaceDocumentManager", () => {
  it("tracks dirty edits and saves with the latest server version", async () => {
    const client = {
      readFile: vi.fn(async () => ({
        cwd: "/repo",
        relativePath: "src/index.ts",
        exists: true,
        contents: "a\n",
        version: { fingerprint: "v1", mtimeMs: 1, sizeBytes: 2 },
        encoding: "utf8" as const,
        eol: "lf" as const,
        readonly: false,
        binary: false,
        tooLarge: false,
      })),
      writeFile: vi.fn(async () => ({
        cwd: "/repo",
        relativePath: "src/index.ts",
        version: { fingerprint: "v2", mtimeMs: 2, sizeBytes: 2 },
        writtenAt: "2026-01-01T00:00:01.000Z",
      })),
    } satisfies WorkspaceDocumentClient;
    const manager = createWorkspaceDocumentManager({
      getRegistry: () => registry,
      getClient: () => client,
    });

    await manager.load(FILE_TARGET);
    manager.edit(FILE_TARGET, "b\n");
    expect(manager.getSnapshot(FILE_TARGET)).toMatchObject({ dirty: true, draftContents: "b\n" });

    await manager.save(FILE_TARGET);

    expect(client.writeFile).toHaveBeenCalledWith({
      cwd: "/repo",
      relativePath: "src/index.ts",
      contents: "b\n",
      expectedVersion: { fingerprint: "v1", mtimeMs: 1, sizeBytes: 2 },
      create: false,
    });
    expect(manager.getSnapshot(FILE_TARGET)).toMatchObject({
      dirty: false,
      serverContents: "b\n",
      version: { fingerprint: "v2", mtimeMs: 2, sizeBytes: 2 },
    });
  });

  it("keeps the local draft when a save conflicts", async () => {
    const conflict = Object.assign(new Error("changed on disk"), { code: "conflict" });
    const client = {
      readFile: vi.fn(async () => ({
        cwd: "/repo",
        relativePath: "src/index.ts",
        exists: true,
        contents: "server\n",
        version: { fingerprint: "v1", mtimeMs: 1, sizeBytes: 7 },
        encoding: "utf8" as const,
        eol: "lf" as const,
        readonly: false,
        binary: false,
        tooLarge: false,
      })),
      writeFile: vi.fn(async () => {
        throw conflict;
      }),
    } satisfies WorkspaceDocumentClient;
    const manager = createWorkspaceDocumentManager({
      getRegistry: () => registry,
      getClient: () => client,
    });

    await manager.load(FILE_TARGET);
    manager.edit(FILE_TARGET, "local draft\n");
    await manager.save(FILE_TARGET);

    expect(manager.getSnapshot(FILE_TARGET)).toMatchObject({
      status: "conflict",
      dirty: true,
      draftContents: "local draft\n",
      serverContents: "server\n",
      externalChange: true,
    });
  });

  it("reloads clean changed documents and preserves dirty drafts", async () => {
    const readFile = vi
      .fn<WorkspaceDocumentClient["readFile"]>()
      .mockResolvedValueOnce({
        cwd: "/repo",
        relativePath: "src/index.ts",
        exists: true,
        contents: "server\n",
        version: { fingerprint: "v1", mtimeMs: 1, sizeBytes: 7 },
        encoding: "utf8" as const,
        eol: "lf" as const,
        readonly: false,
        binary: false,
        tooLarge: false,
      })
      .mockResolvedValueOnce({
        cwd: "/repo",
        relativePath: "src/index.ts",
        exists: true,
        contents: "server updated\n",
        version: { fingerprint: "v2", mtimeMs: 2, sizeBytes: 15 },
        encoding: "utf8" as const,
        eol: "lf" as const,
        readonly: false,
        binary: false,
        tooLarge: false,
      });
    const client = {
      readFile,
      writeFile: vi.fn(),
    } satisfies WorkspaceDocumentClient;
    const manager = createWorkspaceDocumentManager({
      getRegistry: () => registry,
      getClient: () => client,
    });

    await manager.load(FILE_TARGET);
    manager.applyChangeEvent(ENVIRONMENT_ID, {
      cwd: "/repo",
      relativePath: "src/index.ts",
      kind: "updated",
      directoryPath: "src",
      observedAt: "2026-01-01T00:00:01.000Z",
    });
    await vi.waitFor(() => {
      expect(manager.getSnapshot(FILE_TARGET)).toMatchObject({
        dirty: false,
        externalChange: false,
        draftContents: "server updated\n",
        serverContents: "server updated\n",
        version: { fingerprint: "v2" },
      });
    });
    expect(readFile).toHaveBeenCalledTimes(2);

    manager.edit(FILE_TARGET, "local\n");
    manager.applyChangeEvent(ENVIRONMENT_ID, {
      cwd: "/repo",
      relativePath: "src/index.ts",
      kind: "updated",
      directoryPath: "src",
      observedAt: "2026-01-01T00:00:02.000Z",
    });

    expect(manager.getSnapshot(FILE_TARGET)).toMatchObject({
      dirty: true,
      externalChange: true,
      draftContents: "local\n",
    });
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});
