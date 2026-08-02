import type { CreateProjectInput } from "@t3tools/client-runtime/operations";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "./components/ui/toast";
import type { ProviderInstanceEntry } from "./providerInstances";
import { T3_WORK_BACKING_PROJECT_ID, T3_WORK_BACKING_PROJECT_TITLE } from "./t3WorkProject";

export type T3WorkBackingProjectOutcome = "created" | "interrupted" | "failed";

/**
 * Resolve the model the T3 Work backing project should default to for a
 * Hermes provider entry: the "default" slug when present, else the first
 * advertised model.
 */
export function resolveHermesDefaultModel(entry: ProviderInstanceEntry) {
  return entry.models.find((model) => model.slug === "default") ?? entry.models[0] ?? null;
}

const inFlightCreates = new Map<string, Promise<T3WorkBackingProjectOutcome>>();

/**
 * Create the fixed T3 Work backing project. Shared by the sidebar effect and
 * the command palette's "New chat" action so both surface the same failure
 * toast, and concurrent calls for the same environment/directory pair share
 * one in-flight command instead of racing on the fixed project id.
 */
export function createT3WorkBackingProject(options: {
  readonly createProject: (value: {
    readonly environmentId: EnvironmentId;
    readonly input: CreateProjectInput;
  }) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly hermesProviderEntry: ProviderInstanceEntry;
}): Promise<T3WorkBackingProjectOutcome> {
  const key = `${options.environmentId}:${options.workspaceRoot}`;
  const existing = inFlightCreates.get(key);
  if (existing !== undefined) return existing;
  const run = (async (): Promise<T3WorkBackingProjectOutcome> => {
    const hermesModel = resolveHermesDefaultModel(options.hermesProviderEntry);
    const defaultModelSelection: ModelSelection | null =
      hermesModel === null
        ? null
        : {
            instanceId: options.hermesProviderEntry.instanceId,
            model: hermesModel.slug,
          };
    const result = await options.createProject({
      environmentId: options.environmentId,
      input: {
        projectId: T3_WORK_BACKING_PROJECT_ID,
        title: T3_WORK_BACKING_PROJECT_TITLE,
        workspaceRoot: options.workspaceRoot,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection,
      },
    });
    if (result._tag !== "Failure") return "created";
    if (isAtomCommandInterrupted(result)) return "interrupted";
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not prepare T3 Work",
        description:
          error instanceof Error
            ? error.message
            : "The private T3 Work conversation directory could not be created.",
      }),
    );
    return "failed";
  })().finally(() => {
    inFlightCreates.delete(key);
  });
  inFlightCreates.set(key, run);
  return run;
}
