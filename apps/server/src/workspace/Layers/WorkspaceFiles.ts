// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import type { WorkspaceEntry, WorkspaceFileError, WorkspaceFileVersion } from "@t3tools/contracts";

import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceFiles, type WorkspaceFilesShape } from "../Services/WorkspaceFiles.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";
import {
  WORKSPACE_BINARY_DETECTION_BYTES,
  WORKSPACE_EDITOR_TEXT_FILE_LIMIT_BYTES,
  basenameOf,
  isHiddenEntryName,
  isPathInBuiltinIgnoredDirectory,
  isReadonlyMode,
  kindFromStats,
  parentPathOf,
  toPosixPath,
  workspaceFileError,
  workspaceFileErrorFromCause,
} from "./workspaceFileHelpers.ts";

type ResolvedWorkspaceTarget = {
  readonly workspaceRoot: string;
  readonly absolutePath: string;
  readonly relativePath: string;
};

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function detectEol(contents: string): "lf" | "crlf" | "mixed" | "none" {
  const crlfMatches = contents.match(/\r\n/g)?.length ?? 0;
  const lfMatches = contents.match(/(?<!\r)\n/g)?.length ?? 0;
  if (crlfMatches === 0 && lfMatches === 0) return "none";
  if (crlfMatches > 0 && lfMatches > 0) return "mixed";
  return crlfMatches > 0 ? "crlf" : "lf";
}

function isBinaryBuffer(buffer: Uint8Array): boolean {
  if (buffer.includes(0)) {
    return true;
  }
  try {
    fatalUtf8Decoder.decode(buffer);
    return false;
  } catch {
    return true;
  }
}

function versionsEqual(left: WorkspaceFileVersion | null, right: WorkspaceFileVersion | null) {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.fingerprint === right.fingerprint &&
    left.mtimeMs === right.mtimeMs &&
    left.sizeBytes === right.sizeBytes
  );
}

export const makeWorkspaceFiles = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const resolveTarget = Effect.fn("WorkspaceFiles.resolveTarget")(function* (
    cwd: string,
    relativePath: string,
  ): Effect.fn.Return<ResolvedWorkspaceTarget, WorkspaceFileError> {
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
    const target = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot, relativePath })
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

  const verifyRealPathInsideRoot = Effect.fn("WorkspaceFiles.verifyRealPathInsideRoot")(function* (
    workspaceRoot: string,
    absolutePath: string,
    cwd: string,
    relativePath: string,
    message: string,
  ) {
    const [rootRealPath, targetRealPath] = yield* Effect.tryPromise({
      try: () =>
        Promise.all([fsPromises.realpath(workspaceRoot), fsPromises.realpath(absolutePath)]),
      catch: (cause) =>
        workspaceFileErrorFromCause({
          cause,
          fallbackMessage: "Failed to resolve workspace path.",
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
        message,
        cwd,
        relativePath,
      });
    }
  });

  const resolveExistingAncestor = Effect.fn("WorkspaceFiles.resolveExistingAncestor")(function* (
    target: ResolvedWorkspaceTarget,
    cwd: string,
  ) {
    let candidate = path.dirname(target.absolutePath);
    while (candidate !== target.workspaceRoot && candidate.length > target.workspaceRoot.length) {
      const exists = yield* Effect.tryPromise({
        try: () => fsPromises.stat(candidate).then(() => true),
        catch: (cause) => {
          const code =
            cause && typeof cause === "object" && "code" in cause
              ? String((cause as { readonly code?: unknown }).code)
              : "";
          if (code === "ENOENT") {
            return workspaceFileError({
              code: "not_found",
              message: "Workspace ancestor does not exist.",
              cwd,
              relativePath: target.relativePath,
              cause,
            });
          }
          return workspaceFileErrorFromCause({
            cause,
            fallbackMessage: "Failed to stat workspace ancestor.",
            cwd,
            relativePath: target.relativePath,
          });
        },
      }).pipe(
        Effect.catchIf(
          (error) => error.code === "not_found",
          () => Effect.succeed(false),
        ),
      );
      if (exists) {
        return candidate;
      }
      candidate = path.dirname(candidate);
    }
    return target.workspaceRoot;
  });

  const verifyParentInsideRoot = Effect.fn("WorkspaceFiles.verifyParentInsideRoot")(function* (
    target: ResolvedWorkspaceTarget,
    cwd: string,
    options?: { readonly allowMissingParents?: boolean },
  ) {
    const parentPath = options?.allowMissingParents
      ? yield* resolveExistingAncestor(target, cwd)
      : path.dirname(target.absolutePath);
    yield* verifyRealPathInsideRoot(
      target.workspaceRoot,
      parentPath,
      cwd,
      target.relativePath,
      "Parent directory resolves outside the workspace root.",
    );
  });

  const lstatOrNull = (absolutePath: string, cwd: string, relativePath: string) =>
    Effect.tryPromise({
      try: () => fsPromises.lstat(absolutePath),
      catch: (cause) =>
        workspaceFileErrorFromCause({
          cause,
          fallbackMessage: "Failed to stat workspace path.",
          cwd,
          relativePath,
        }),
    }).pipe(
      Effect.catchIf(
        (error) => error.code === "not_found",
        () => Effect.succeed(null),
      ),
    );

  const readVersion = Effect.fn("WorkspaceFiles.readVersion")(function* (
    absolutePath: string,
    cwd: string,
    relativePath: string,
  ) {
    const [stats, contents] = yield* Effect.tryPromise({
      try: () => Promise.all([fsPromises.stat(absolutePath), fsPromises.readFile(absolutePath)]),
      catch: (cause) =>
        workspaceFileErrorFromCause({
          cause,
          fallbackMessage: "Failed to read workspace file version.",
          cwd,
          relativePath,
        }),
    });
    if (!stats.isFile()) {
      return yield* workspaceFileError({
        code: "not_file",
        message: "Workspace path is not a file.",
        cwd,
        relativePath,
      });
    }
    return {
      fingerprint: `${stats.mtimeMs}:${stats.size}:${sha256Hex(contents)}`,
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
    } satisfies WorkspaceFileVersion;
  });

  const makeEntry = Effect.fn("WorkspaceFiles.makeEntry")(function* (
    target: ResolvedWorkspaceTarget,
  ) {
    const lstat = yield* Effect.tryPromise({
      try: () => fsPromises.lstat(target.absolutePath),
      catch: (cause) =>
        workspaceFileErrorFromCause({
          cause,
          fallbackMessage: "Failed to read workspace entry metadata.",
          cwd: target.workspaceRoot,
          relativePath: target.relativePath,
        }),
    });
    const kind = kindFromStats(lstat);
    const symlinkTarget =
      kind === "symlink"
        ? yield* Effect.tryPromise({
            try: () => fsPromises.readlink(target.absolutePath),
            catch: (cause) =>
              workspaceFileErrorFromCause({
                cause,
                fallbackMessage: "Failed to read workspace symlink target.",
                cwd: target.workspaceRoot,
                relativePath: target.relativePath,
              }),
          }).pipe(Effect.catch(() => Effect.succeed(null)))
        : null;
    const name = basenameOf(target.relativePath);
    const parentPath = parentPathOf(target.relativePath);
    return {
      relativePath: target.relativePath,
      name,
      kind,
      ...(parentPath ? { parentPath } : {}),
      sizeBytes: lstat.size,
      mtimeMs: lstat.mtimeMs,
      readonly: isReadonlyMode(lstat.mode),
      hidden: isHiddenEntryName(name),
      ignored: isPathInBuiltinIgnoredDirectory(target.relativePath),
      ...(symlinkTarget !== null ? { symlinkTarget } : {}),
    } satisfies WorkspaceEntry;
  });

  const readFile: WorkspaceFilesShape["readFile"] = Effect.fn("WorkspaceFiles.readFile")(
    function* (input) {
      const target = yield* resolveTarget(input.cwd, input.relativePath);
      const lstat = yield* lstatOrNull(target.absolutePath, input.cwd, target.relativePath);
      if (lstat === null) {
        return {
          cwd: input.cwd,
          relativePath: target.relativePath,
          exists: false,
          contents: null,
          version: null,
          encoding: "utf8",
          eol: "none",
          readonly: false,
          binary: false,
          tooLarge: false,
        };
      }

      yield* verifyRealPathInsideRoot(
        target.workspaceRoot,
        target.absolutePath,
        input.cwd,
        target.relativePath,
        "File symlink resolves outside the workspace root.",
      );

      const stats = yield* Effect.tryPromise({
        try: () => fsPromises.stat(target.absolutePath),
        catch: (cause) =>
          workspaceFileErrorFromCause({
            cause,
            fallbackMessage: "Failed to stat workspace file.",
            cwd: input.cwd,
            relativePath: target.relativePath,
          }),
      });
      if (!stats.isFile()) {
        return yield* workspaceFileError({
          code: "not_file",
          message: "Workspace path is not a file.",
          cwd: input.cwd,
          relativePath: target.relativePath,
        });
      }

      const readonly = isReadonlyMode(lstat.mode) || isReadonlyMode(stats.mode);
      const maxBytes = input.maxBytes ?? WORKSPACE_EDITOR_TEXT_FILE_LIMIT_BYTES;
      if (stats.size > maxBytes) {
        return {
          cwd: input.cwd,
          relativePath: target.relativePath,
          exists: true,
          contents: null,
          version: null,
          encoding: "utf8",
          eol: "none",
          readonly,
          binary: false,
          tooLarge: true,
        };
      }

      const contentsBuffer = yield* Effect.tryPromise({
        try: () => fsPromises.readFile(target.absolutePath),
        catch: (cause) =>
          workspaceFileErrorFromCause({
            cause,
            fallbackMessage: "Failed to read workspace file.",
            cwd: input.cwd,
            relativePath: target.relativePath,
          }),
      });
      const detectionBuffer = contentsBuffer.subarray(
        0,
        Math.min(contentsBuffer.byteLength, WORKSPACE_BINARY_DETECTION_BYTES),
      );
      if (isBinaryBuffer(detectionBuffer) || isBinaryBuffer(contentsBuffer)) {
        return {
          cwd: input.cwd,
          relativePath: target.relativePath,
          exists: true,
          contents: null,
          version: null,
          encoding: "utf8",
          eol: "none",
          readonly,
          binary: true,
          tooLarge: false,
        };
      }

      const contents = contentsBuffer.toString("utf8");
      const latestStats = yield* Effect.tryPromise({
        try: () => fsPromises.stat(target.absolutePath),
        catch: (cause) =>
          workspaceFileErrorFromCause({
            cause,
            fallbackMessage: "Failed to stat workspace file after read.",
            cwd: input.cwd,
            relativePath: target.relativePath,
          }),
      });
      const version = {
        fingerprint: `${latestStats.mtimeMs}:${latestStats.size}:${sha256Hex(contentsBuffer)}`,
        mtimeMs: latestStats.mtimeMs,
        sizeBytes: latestStats.size,
      };
      return {
        cwd: input.cwd,
        relativePath: target.relativePath,
        exists: true,
        contents,
        version,
        encoding: "utf8",
        eol: detectEol(contents),
        readonly,
        binary: false,
        tooLarge: false,
      };
    },
  );

  const writeFile: WorkspaceFilesShape["writeFile"] = Effect.fn("WorkspaceFiles.writeFile")(
    function* (input) {
      const target = yield* resolveTarget(input.cwd, input.relativePath);
      const lstat = yield* lstatOrNull(target.absolutePath, input.cwd, target.relativePath);
      yield* verifyParentInsideRoot(target, input.cwd, {
        allowMissingParents: input.create === true,
      });

      if (lstat !== null) {
        yield* verifyRealPathInsideRoot(
          target.workspaceRoot,
          target.absolutePath,
          input.cwd,
          target.relativePath,
          "File symlink resolves outside the workspace root.",
        );
        if (lstat.isDirectory()) {
          return yield* workspaceFileError({
            code: "not_file",
            message: "Workspace path is a directory.",
            cwd: input.cwd,
            relativePath: target.relativePath,
          });
        }
        if (isReadonlyMode(lstat.mode) && input.overwriteReadonly !== true) {
          return yield* workspaceFileError({
            code: "readonly",
            message: "Workspace file is read-only.",
            cwd: input.cwd,
            relativePath: target.relativePath,
          });
        }
      }

      const currentVersion =
        lstat === null
          ? null
          : yield* readVersion(target.absolutePath, input.cwd, target.relativePath);
      if (!versionsEqual(input.expectedVersion, currentVersion)) {
        return yield* workspaceFileError({
          code: "conflict",
          message:
            currentVersion === null
              ? "Workspace file no longer exists."
              : "Workspace file changed on disk since it was opened.",
          cwd: input.cwd,
          relativePath: target.relativePath,
        });
      }

      if (lstat === null && input.create !== true) {
        yield* Effect.tryPromise({
          try: () => fsPromises.access(path.dirname(target.absolutePath)),
          catch: (cause) =>
            workspaceFileErrorFromCause({
              cause,
              fallbackMessage: "Parent directory does not exist.",
              cwd: input.cwd,
              relativePath: target.relativePath,
            }),
        });
      }
      if (input.create === true) {
        yield* Effect.tryPromise({
          try: () => fsPromises.mkdir(path.dirname(target.absolutePath), { recursive: true }),
          catch: (cause) =>
            workspaceFileErrorFromCause({
              cause,
              fallbackMessage: "Failed to create parent directories.",
              cwd: input.cwd,
              relativePath: target.relativePath,
            }),
        });
      }

      yield* Effect.tryPromise({
        try: () => fsPromises.writeFile(target.absolutePath, input.contents, "utf8"),
        catch: (cause) =>
          workspaceFileErrorFromCause({
            cause,
            fallbackMessage: "Failed to write workspace file.",
            cwd: input.cwd,
            relativePath: target.relativePath,
          }),
      });
      yield* workspaceEntries.invalidate(input.cwd);
      const version = yield* readVersion(target.absolutePath, input.cwd, target.relativePath);
      const now = yield* DateTime.now;
      return {
        cwd: input.cwd,
        relativePath: target.relativePath,
        version,
        writtenAt: DateTime.formatIso(now),
      };
    },
  );

  const createFile: WorkspaceFilesShape["createFile"] = Effect.fn("WorkspaceFiles.createFile")(
    function* (input) {
      const writeResult = yield* writeFile({
        cwd: input.cwd,
        relativePath: input.relativePath,
        contents: input.contents ?? "",
        expectedVersion: null,
      });
      const target = yield* resolveTarget(input.cwd, writeResult.relativePath);
      const entry = yield* makeEntry(target);
      return {
        cwd: input.cwd,
        relativePath: writeResult.relativePath,
        entry,
        changedAt: writeResult.writtenAt,
      };
    },
  );

  const createDirectory: WorkspaceFilesShape["createDirectory"] = Effect.fn(
    "WorkspaceFiles.createDirectory",
  )(function* (input) {
    const target = yield* resolveTarget(input.cwd, input.relativePath);
    yield* verifyParentInsideRoot(target, input.cwd);
    yield* Effect.tryPromise({
      try: () => fsPromises.mkdir(target.absolutePath),
      catch: (cause) =>
        workspaceFileErrorFromCause({
          cause,
          fallbackMessage: "Failed to create workspace directory.",
          cwd: input.cwd,
          relativePath: target.relativePath,
        }),
    });
    yield* workspaceEntries.invalidate(input.cwd);
    const entry = yield* makeEntry(target);
    const now = yield* DateTime.now;
    return {
      cwd: input.cwd,
      relativePath: target.relativePath,
      entry,
      changedAt: DateTime.formatIso(now),
    };
  });

  const rename: WorkspaceFilesShape["rename"] = Effect.fn("WorkspaceFiles.rename")(
    function* (input) {
      const fromTarget = yield* resolveTarget(input.cwd, input.fromRelativePath);
      const toTarget = yield* resolveTarget(input.cwd, input.toRelativePath);
      yield* verifyRealPathInsideRoot(
        fromTarget.workspaceRoot,
        fromTarget.absolutePath,
        input.cwd,
        fromTarget.relativePath,
        "Source path resolves outside the workspace root.",
      );
      yield* verifyParentInsideRoot(toTarget, input.cwd);
      const destinationExists = yield* lstatOrNull(
        toTarget.absolutePath,
        input.cwd,
        toTarget.relativePath,
      );
      if (destinationExists !== null) {
        return yield* workspaceFileError({
          code: "already_exists",
          message: "Destination already exists.",
          cwd: input.cwd,
          relativePath: toTarget.relativePath,
        });
      }
      yield* Effect.tryPromise({
        try: () => fsPromises.rename(fromTarget.absolutePath, toTarget.absolutePath),
        catch: (cause) =>
          workspaceFileErrorFromCause({
            cause,
            fallbackMessage: "Failed to rename workspace path.",
            cwd: input.cwd,
            relativePath: fromTarget.relativePath,
          }),
      });
      yield* workspaceEntries.invalidate(input.cwd);
      const entry = yield* makeEntry(toTarget);
      const now = yield* DateTime.now;
      return {
        cwd: input.cwd,
        fromRelativePath: fromTarget.relativePath,
        toRelativePath: toTarget.relativePath,
        entry,
        changedAt: DateTime.formatIso(now),
      };
    },
  );

  const deletePath: WorkspaceFilesShape["delete"] = Effect.fn("WorkspaceFiles.delete")(
    function* (input) {
      const target = yield* resolveTarget(input.cwd, input.relativePath);
      const lstat = yield* lstatOrNull(target.absolutePath, input.cwd, target.relativePath);
      if (lstat === null) {
        return yield* workspaceFileError({
          code: "not_found",
          message: "Workspace path does not exist.",
          cwd: input.cwd,
          relativePath: target.relativePath,
        });
      }
      yield* verifyRealPathInsideRoot(
        target.workspaceRoot,
        target.absolutePath,
        input.cwd,
        target.relativePath,
        "Workspace path resolves outside the workspace root.",
      );
      yield* Effect.tryPromise({
        try: () =>
          lstat.isDirectory()
            ? fsPromises.rmdir(target.absolutePath)
            : fsPromises.unlink(target.absolutePath),
        catch: (cause) =>
          workspaceFileErrorFromCause({
            cause,
            fallbackMessage: "Failed to delete workspace path.",
            cwd: input.cwd,
            relativePath: target.relativePath,
          }),
      });
      yield* workspaceEntries.invalidate(input.cwd);
      const now = yield* DateTime.now;
      return {
        cwd: input.cwd,
        relativePath: target.relativePath,
        changedAt: DateTime.formatIso(now),
      };
    },
  );

  return {
    readFile,
    writeFile,
    createFile,
    createDirectory,
    rename,
    delete: deletePath,
  } satisfies WorkspaceFilesShape;
});

export const WorkspaceFilesLive = Layer.effect(WorkspaceFiles, makeWorkspaceFiles);
