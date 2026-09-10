import type { ThreadId } from "@t3tools/contracts";
import { resolveProjectAgentBrowserAccess } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

/** Missing thread identity or unreadable settings must not bypass an explicit project choice. */
export const agentBrowserAccessEnabled = Effect.fn("V2.agentBrowserAccessEnabled")(
  function* (threadId: ThreadId) {
    const settingsService = yield* ServerSettingsService;
    const settings = yield* settingsService.getSettings;
    if (Object.keys(settings.projectAgentBrowserAccessOverrides).length === 0) {
      return settings.enableAgentBrowserAccess;
    }
    const projections = yield* ProjectionStoreV2;
    const thread = yield* projections.getThreadShell(threadId);
    return thread === null ? false : resolveProjectAgentBrowserAccess(settings, thread.projectId);
  },
  Effect.catch((cause) =>
    Effect.logWarning("Could not resolve project browser access; withholding preview tools.", {
      cause,
    }).pipe(Effect.as(false)),
  ),
);
