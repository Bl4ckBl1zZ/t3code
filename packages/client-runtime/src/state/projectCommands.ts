import {
  type EnvironmentId,
  type ProjectReadFileResult,
  T3_PROJECT_FILE_NAME,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import {
  type EnvironmentRpcInput,
  type EnvironmentRpcSuccess,
  request,
  requestGuarded,
} from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import {
  type CreateProjectInput,
  type DeleteProjectInput,
  type UpdateProjectInput,
  createProject,
  deleteProject,
  updateProject,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createFileMetadataAtoms } from "./fileMetadata.ts";
import { resolveWorkspaceFilePath } from "@t3tools/shared/path";

export type {
  CreateProjectInput,
  DeleteProjectInput,
  UpdateProjectInput,
} from "../operations/commands.ts";

export interface OptimisticProjectFile {
  readonly data: ProjectReadFileResult;
  readonly confirmedAgainst: object | null | undefined;
}

export interface OptimisticProjectFileTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

function optimisticProjectFileKey(target: OptimisticProjectFileTarget): string {
  return JSON.stringify([target.environmentId, target.cwd, target.relativePath]);
}

function writtenFilePaths(
  input: EnvironmentRpcInput<typeof WS_METHODS.projectsWriteFile>,
  result: EnvironmentRpcSuccess<typeof WS_METHODS.projectsWriteFile>,
) {
  return new Set(
    [result.relativePath, input.relativePath].map((path) =>
      resolveWorkspaceFilePath(path, input.cwd),
    ),
  );
}

export function createProjectEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const fileMetadata = createFileMetadataAtoms(runtime);
  const projectScheduler = createAtomCommandScheduler();
  const fileScheduler = createAtomCommandScheduler();
  const readFile = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:projects:read-file",
    tag: WS_METHODS.projectsReadFile,
    staleTimeMs: 30_000,
    idleTtlMs: 5 * 60_000,
    execute: (input) =>
      fileMetadata.seedAfterRead(request(WS_METHODS.projectsReadFile, input), (result, isCurrent) =>
        fileMetadata.rememberFile(input.cwd, result, isCurrent),
      ),
  });
  // Share one refresh timer across all consumers of a checkout's config.
  // Dispose it as soon as the last consumer leaves, including file viewers.
  const liveProjectFile = Atom.family((atom: ReturnType<typeof readFile>) =>
    atom.pipe(Atom.withRefresh(1_500), Atom.setIdleTTL(0)),
  );
  const optimisticFileFamily = Atom.family((key: string) =>
    Atom.make<OptimisticProjectFile | null>(null).pipe(
      Atom.withLabel(`environment-data:projects:optimistic-file:${key}`),
    ),
  );
  const projectConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { projectId: string } }) =>
      JSON.stringify([environmentId, input.projectId]),
  };
  return {
    fileMetadata: fileMetadata.metadata,
    fileMetadataThread: fileMetadata.retainThread,
    invalidateFileMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:filesystem:invalidate-metadata",
      execute: (input: { paths: ReadonlyArray<string> }, registry, environmentId) =>
        Effect.forEach([...new Set(input.paths)], (path) =>
          fileMetadata
            .invalidate(path)
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => fileMetadata.refreshPath(environmentId, path, registry)),
              ),
            ),
        ),
    }),
    searchEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:search-entries",
      tag: WS_METHODS.projectsSearchEntries,
      staleTimeMs: 15_000,
      execute: (input) =>
        fileMetadata.seedAfterRead(
          request(WS_METHODS.projectsSearchEntries, input),
          (result, isCurrent) => fileMetadata.rememberEntries(input.cwd, result.entries, isCurrent),
        ),
    }),
    listEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-entries",
      tag: WS_METHODS.projectsListEntries,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
      execute: (input) =>
        fileMetadata.seedAfterRead(
          request(WS_METHODS.projectsListEntries, input),
          (result, isCurrent) => fileMetadata.rememberEntries(input.cwd, result.entries, isCurrent),
        ),
    }),
    readFile: (target: Parameters<typeof readFile>[0]) => {
      const atom = readFile(target);
      return target.input.relativePath === T3_PROJECT_FILE_NAME ? liveProjectFile(atom) : atom;
    },
    optimisticFile: (target: OptimisticProjectFileTarget) =>
      optimisticFileFamily(optimisticProjectFileKey(target)),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:create",
      execute: (input: CreateProjectInput) => createProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:update",
      execute: (input: UpdateProjectInput) => updateProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:delete",
      execute: (input: DeleteProjectInput) => deleteProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    // Finds or creates the environment's Scratch project and returns its id.
    ensureScratch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:ensure-scratch",
      tag: WS_METHODS.projectsEnsureScratch,
      scheduler: projectScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    // Makes a new folder and repository from just a name, then the project.
    createNew: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:create-new",
      tag: WS_METHODS.projectsCreateNew,
      scheduler: projectScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    writeFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:write-file",
      tag: WS_METHODS.projectsWriteFile,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
      execute: (input) =>
        requestGuarded(WS_METHODS.projectsWriteFile, input).pipe(
          Effect.tap((result) =>
            Effect.forEach(writtenFilePaths(input, result), fileMetadata.invalidate),
          ),
        ),
      onSuccess: ({ environmentId, input }, registry, result) =>
        Effect.sync(() => {
          for (const path of writtenFilePaths(input, result))
            fileMetadata.refreshPath(environmentId, path, registry);
        }),
    }),
  };
}
