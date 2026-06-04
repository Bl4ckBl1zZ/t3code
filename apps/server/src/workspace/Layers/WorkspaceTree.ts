// @effect-diagnostics nodeBuiltinImport:off
import fsPromises from "node:fs/promises";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import type { WorkspaceEntry } from "@t3tools/contracts";

import { VcsDriverRegistry } from "../../vcs/VcsDriverRegistry.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";
import { WorkspaceTree, type WorkspaceTreeShape } from "../Services/WorkspaceTree.ts";
import {
  basenameOf,
  childRelativePath,
  isHiddenEntryName,
  isPathInBuiltinIgnoredDirectory,
  isReadonlyMode,
  kindFromStats,
  normalizeDirectoryRelativePath,
  parentPathOf,
  toPosixPath,
  workspaceFileError,
  workspaceFileErrorFromCause,
} from "./workspaceFileHelpers.ts";

function entrySortValue(entry: WorkspaceEntry): string {
  return entry.name.toLocaleLowerCase();
}

function sortEntries(left: WorkspaceEntry, right: WorkspaceEntry): number {
  const leftDirectory = left.kind === "directory";
  const rightDirectory = right.kind === "directory";
  if (leftDirectory !== rightDirectory) {
    return leftDirectory ? -1 : 1;
  }
  return entrySortValue(left).localeCompare(entrySortValue(right));
}

export const makeWorkspaceTree = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const vcsRegistry = yield* VcsDriverRegistry;

  const filterVcsIgnoredPaths = (cwd: string, relativePaths: string[]) =>
    vcsRegistry.detect({ cwd }).pipe(
      Effect.flatMap((handle) =>
        handle
          ? handle.driver.filterIgnoredPaths(cwd, relativePaths).pipe(
              Effect.map((paths) => new Set(paths)),
              Effect.catch(() => Effect.succeed(new Set(relativePaths))),
            )
          : Effect.succeed(new Set(relativePaths)),
      ),
      Effect.catch(() => Effect.succeed(new Set(relativePaths))),
    );

  const resolveDirectory = Effect.fn("WorkspaceTree.resolveDirectory")(function* (
    cwd: string,
    relativePath: string,
  ) {
    const workspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.mapError((cause) =>
        workspaceFileError({
          code: "not_directory",
          message: cause.message,
          cwd,
          relativePath,
          cause,
        }),
      ),
    );
    if (relativePath.length === 0) {
      return {
        workspaceRoot,
        absolutePath: workspaceRoot,
        relativePath,
      };
    }
    const target = yield* workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot,
        relativePath,
      })
      .pipe(
        Effect.mapError((cause) =>
          workspaceFileError({
            code: "outside_root",
            message: "Workspace file path must stay within the project root.",
            cwd,
            relativePath,
            cause,
          }),
        ),
      );
    return { workspaceRoot, ...target };
  });

  const verifyDirectoryInsideRoot = Effect.fn("WorkspaceTree.verifyDirectoryInsideRoot")(function* (
    workspaceRoot: string,
    absolutePath: string,
    cwd: string,
    relativePath: string,
  ) {
    const [rootRealPath, targetRealPath] = yield* Effect.tryPromise({
      try: () =>
        Promise.all([fsPromises.realpath(workspaceRoot), fsPromises.realpath(absolutePath)]),
      catch: (cause) =>
        workspaceFileErrorFromCause({
          cause,
          fallbackMessage: "Failed to resolve workspace directory.",
          cwd,
          relativePath,
        }),
    });
    const relativeToRoot = toPosixPath(path.relative(rootRealPath, targetRealPath));
    if (
      relativeToRoot.startsWith("../") ||
      relativeToRoot === ".." ||
      path.isAbsolute(relativeToRoot)
    ) {
      return yield* workspaceFileError({
        code: "unsafe_symlink",
        message: "Directory symlink resolves outside the workspace root.",
        cwd,
        relativePath,
      });
    }
  });

  const listDirectory: WorkspaceTreeShape["listDirectory"] = Effect.fn(
    "WorkspaceTree.listDirectory",
  )(function* (input) {
    const relativePath = normalizeDirectoryRelativePath(input.relativePath);
    const target = yield* resolveDirectory(input.cwd, relativePath);
    yield* verifyDirectoryInsideRoot(
      target.workspaceRoot,
      target.absolutePath,
      input.cwd,
      relativePath,
    );

    const stats = yield* Effect.tryPromise({
      try: () => fsPromises.stat(target.absolutePath),
      catch: (cause) =>
        workspaceFileErrorFromCause({
          cause,
          fallbackMessage: "Failed to stat workspace directory.",
          cwd: input.cwd,
          relativePath,
        }),
    });
    if (!stats.isDirectory()) {
      return yield* workspaceFileError({
        code: "not_directory",
        message: "Workspace path is not a directory.",
        cwd: input.cwd,
        relativePath,
      });
    }

    const dirents = yield* Effect.tryPromise({
      try: () => fsPromises.readdir(target.absolutePath, { withFileTypes: true }),
      catch: (cause) =>
        workspaceFileErrorFromCause({
          cause,
          fallbackMessage: "Failed to list workspace directory.",
          cwd: input.cwd,
          relativePath,
        }),
    });

    const candidatePaths = dirents.map((dirent) => childRelativePath(relativePath, dirent.name));
    const vcsIncludedPaths = yield* filterVcsIgnoredPaths(input.cwd, candidatePaths);
    const includeHidden = input.includeHidden === true;
    const includeIgnored = input.includeIgnored === true;

    const entries = yield* Effect.tryPromise({
      try: async () => {
        const nextEntries: WorkspaceEntry[] = [];
        await Promise.all(
          dirents.map(async (dirent) => {
            const entryRelativePath = childRelativePath(relativePath, dirent.name);
            const hidden = isHiddenEntryName(dirent.name);
            const ignored =
              isPathInBuiltinIgnoredDirectory(entryRelativePath) ||
              !vcsIncludedPaths.has(entryRelativePath);
            if ((!includeHidden && hidden) || (!includeIgnored && ignored)) {
              return;
            }

            const absolutePath = path.join(target.absolutePath, dirent.name);
            const lstat = await fsPromises.lstat(absolutePath);
            const kind = kindFromStats(lstat);
            const symlinkTarget =
              kind === "symlink" ? await fsPromises.readlink(absolutePath) : undefined;
            const parentPath = parentPathOf(entryRelativePath);
            nextEntries.push({
              relativePath: entryRelativePath,
              name: basenameOf(entryRelativePath),
              kind,
              ...(parentPath ? { parentPath } : {}),
              sizeBytes: lstat.size,
              mtimeMs: lstat.mtimeMs,
              readonly: isReadonlyMode(lstat.mode),
              hidden,
              ignored,
              ...(symlinkTarget !== undefined ? { symlinkTarget } : {}),
            });
          }),
        );
        return nextEntries;
      },
      catch: (cause) =>
        workspaceFileErrorFromCause({
          cause,
          fallbackMessage: "Failed to read workspace directory metadata.",
          cwd: input.cwd,
          relativePath,
        }),
    });

    const sortedEntries = entries.toSorted(sortEntries);
    const truncated = sortedEntries.length > input.limit;
    const now = yield* DateTime.now;
    return {
      cwd: input.cwd,
      relativePath,
      entries: sortedEntries.slice(0, input.limit),
      truncated,
      scannedAt: DateTime.formatIso(now),
    };
  });

  return {
    listDirectory,
  } satisfies WorkspaceTreeShape;
});

export const WorkspaceTreeLive = Layer.effect(WorkspaceTree, makeWorkspaceTree);
