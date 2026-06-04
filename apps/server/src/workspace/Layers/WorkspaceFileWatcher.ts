// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import { watch, type FSWatcher } from "node:fs";
import fsPromises from "node:fs/promises";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Path from "effect/Path";

import type {
  WorkspaceFileChangeEvent,
  WorkspaceFileChangeKind,
  WorkspaceFileError,
} from "@t3tools/contracts";

import {
  WorkspaceFileWatcher,
  type WorkspaceFileWatcherShape,
} from "../Services/WorkspaceFileWatcher.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";
import { directoryPathOf, toPosixPath, workspaceFileError } from "./workspaceFileHelpers.ts";

type ChangeListener = (event: WorkspaceFileChangeEvent) => void;

type WatchRecord = {
  refCount: number;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly rootRealPath: string;
  watcher: FSWatcher;
  readonly listeners: Set<ChangeListener>;
  readonly timers: Map<string, ReturnType<typeof setTimeout>>;
};

const WATCH_COALESCE_MS = 75;

function isInsideRoot(pathService: Path.Path, root: string, absolutePath: string): boolean {
  const relativeToRoot = toPosixPath(pathService.relative(root, absolutePath));
  return (
    relativeToRoot.length === 0 ||
    (!relativeToRoot.startsWith("../") &&
      relativeToRoot !== ".." &&
      !pathService.isAbsolute(relativeToRoot))
  );
}

function normalizeWatchRelativePath(relativePath: string): string {
  const normalized = toPosixPath(relativePath).replace(/^\/+/, "");
  return normalized.length > 0 ? normalized : ".";
}

function stopWatcher(record: WatchRecord): void {
  for (const timer of record.timers.values()) {
    clearTimeout(timer);
  }
  record.timers.clear();
  record.watcher.close();
}

async function detectChangeKind(
  absolutePath: string,
  eventType: string,
): Promise<WorkspaceFileChangeKind> {
  if (eventType === "change") {
    return "updated";
  }
  try {
    await fsPromises.lstat(absolutePath);
    return "created";
  } catch (cause) {
    const code =
      cause && typeof cause === "object" && "code" in cause
        ? String((cause as { readonly code?: unknown }).code)
        : "";
    return code === "ENOENT" ? "deleted" : "unknown";
  }
}

export const makeWorkspaceFileWatcher = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const watchers = new Map<string, WatchRecord>();

  const scheduleEvent = (
    record: WatchRecord,
    filename: string | Buffer | null,
    eventType: string,
  ) => {
    const filenameText = filename ? filename.toString() : "";
    const absolutePath = path.resolve(record.rootRealPath, filenameText);
    if (!isInsideRoot(path, record.rootRealPath, absolutePath)) {
      return;
    }
    const relativePath = normalizeWatchRelativePath(
      path.relative(record.rootRealPath, absolutePath),
    );
    const existingTimer = record.timers.get(relativePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      record.timers.delete(relativePath);
      void detectChangeKind(absolutePath, eventType)
        .then((kind) => {
          const event: WorkspaceFileChangeEvent = {
            cwd: record.cwd,
            relativePath,
            kind,
            directoryPath: relativePath === "." ? "" : directoryPathOf(relativePath),
            observedAt: DateTime.formatIso(DateTime.nowUnsafe()),
          };
          for (const listener of record.listeners) {
            listener(event);
          }
        })
        .catch(() => undefined);
    }, WATCH_COALESCE_MS);
    record.timers.set(relativePath, timer);
  };

  const retainWatcher = Effect.fn("WorkspaceFileWatcher.retainWatcher")(function* (
    cwd: string,
    listener: ChangeListener,
  ) {
    const workspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.mapError((cause) =>
        workspaceFileError({
          code: "not_directory",
          message: cause.message,
          cwd,
          cause,
        }),
      ),
    );
    const rootRealPath = yield* Effect.tryPromise({
      try: () => fsPromises.realpath(workspaceRoot),
      catch: (cause) =>
        workspaceFileError({
          code: "watch_unavailable",
          message: cause instanceof Error ? cause.message : "Workspace watcher unavailable.",
          cwd,
          cause,
        }),
    });
    const key = rootRealPath;
    const existing = watchers.get(key);
    if (existing) {
      existing.refCount += 1;
      existing.listeners.add(listener);
      return () => {
        existing.listeners.delete(listener);
        existing.refCount -= 1;
        if (existing.refCount <= 0) {
          stopWatcher(existing);
          watchers.delete(key);
        }
      };
    }

    const record = yield* Effect.try({
      try: () => {
        const listeners = new Set<ChangeListener>([listener]);
        const timers = new Map<string, ReturnType<typeof setTimeout>>();
        const nextRecord: WatchRecord = {
          refCount: 1,
          cwd,
          workspaceRoot,
          rootRealPath,
          watcher: null as unknown as FSWatcher,
          listeners,
          timers,
        };
        const watcher = watch(rootRealPath, { recursive: true }, (eventType, filename) =>
          scheduleEvent(nextRecord, filename, eventType),
        );
        nextRecord.watcher = watcher;
        return nextRecord;
      },
      catch: (cause) =>
        workspaceFileError({
          code: "watch_unavailable",
          message: cause instanceof Error ? cause.message : "Workspace watcher unavailable.",
          cwd,
          cause,
        }),
    });
    watchers.set(key, record);
    return () => {
      record.listeners.delete(listener);
      record.refCount -= 1;
      if (record.refCount <= 0) {
        stopWatcher(record);
        watchers.delete(key);
      }
    };
  });

  const subscribeChanges: WorkspaceFileWatcherShape["subscribeChanges"] = (input) =>
    Stream.callback<WorkspaceFileChangeEvent, WorkspaceFileError>((queue) =>
      Effect.acquireRelease(
        retainWatcher(input.cwd, (event) => {
          Effect.runFork(Queue.offer(queue, event));
        }),
        (release) => Effect.sync(release),
      ),
    );

  return {
    subscribeChanges,
  } satisfies WorkspaceFileWatcherShape;
});

export const WorkspaceFileWatcherLive = Layer.effect(
  WorkspaceFileWatcher,
  makeWorkspaceFileWatcher,
);
