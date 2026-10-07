import { OrchestratorMcpFailure, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    pullRequestMergeMethod,
    projectPullRequestMergeMethodOverrides,
    removeAgentCreditsOnMerge,
    projectRemoveAgentCreditsOnMergeOverrides,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    pullRequestMergeMethod,
    projectPullRequestMergeMethodOverrides,
    removeAgentCreditsOnMerge,
    projectRemoveAgentCreditsOnMergeOverrides,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
export const EnvironmentHandlersLive = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
      };
    }),
  ),
  // Upstream serializes this against the caller thread's other commands with a
  // shared keyed executor and re-runs the declaration's check under that lock.
  // Our orchestrator keeps its executor private, and a second one would be a
  // lock over nothing; nothing waits between the check and the write here, and
  // `updateSettings` does its own read-modify-write under a write semaphore.
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch) =>
    Effect.gen(function* () {
      const { settings } = yield* access;
      return preferences(yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)));
    }),
  ),
});
