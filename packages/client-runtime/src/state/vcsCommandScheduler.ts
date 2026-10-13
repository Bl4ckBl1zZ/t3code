import type { EnvironmentId } from "@t3tools/contracts";

import { createAtomCommandScheduler, type AtomCommandConcurrency } from "./runtime.ts";

export const vcsCommandScheduler = createAtomCommandScheduler();

export const vcsCommandConcurrency: AtomCommandConcurrency<{
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string };
}> = {
  mode: "serial",
  key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
};

/**
 * Working-tree refreshes fire after every agent edit. A burst runs at most one
 * `git status` behind the one in flight, and that trailing run still sees the
 * last edit.
 */
export const vcsLocalStatusConcurrency: AtomCommandConcurrency<{
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string };
}> = {
  mode: "latest",
  key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
};
