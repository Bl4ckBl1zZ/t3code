import type { EnvironmentId, UsageSummaryInput } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/unstable/reactivity";
import type { createEnvironmentPresentationAtoms } from "./presentation.ts";
import { executeAtomQuery } from "./runtime.ts";
import type { createServerEnvironmentAtoms } from "./server.ts";

/** Invalidate every selected summary and await rescans while their machines remain connected. */
export async function refreshUsage({
  registry,
  server,
  presentations,
  environmentIds,
  input,
}: {
  registry: AtomRegistry.AtomRegistry;
  server: Pick<ReturnType<typeof createServerEnvironmentAtoms>, "usageSummary">;
  presentations: Pick<ReturnType<typeof createEnvironmentPresentationAtoms>, "presentationAtom">;
  environmentIds: readonly EnvironmentId[];
  input: UsageSummaryInput;
}): Promise<void> {
  await Promise.all(
    environmentIds.map(async (environmentId) => {
      const query = server.usageSummary({ environmentId, input });
      const presentation = presentations.presentationAtom(environmentId);
      const controller = new AbortController();
      const abortWhenDisconnected = () => {
        if (registry.get(presentation)?.connection.phase !== "connected") controller.abort();
      };
      const unsubscribe = registry.subscribe(presentation, abortWhenDisconnected);
      abortWhenDisconnected();
      try {
        registry.refresh(query);
        if (controller.signal.aborted) return;
        await executeAtomQuery(registry, query, {
          reportFailure: false,
          signal: controller.signal,
        });
      } finally {
        unsubscribe();
      }
    }),
  );
}
