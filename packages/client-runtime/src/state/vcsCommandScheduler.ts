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
 * Working-tree status refreshes are polled while agents edit, so they coalesce
 * instead of queueing: a repo whose `git status` outlives the poll interval
 * would otherwise accumulate an unbounded FIFO backlog.
 */
export const vcsLocalStatusConcurrency: AtomCommandConcurrency<{
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string };
}> = {
  mode: "singleFlight",
  key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
};
