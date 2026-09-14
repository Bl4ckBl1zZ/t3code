import { ORCHESTRATION_V2_WS_METHODS, ThreadId, WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

import { createHermesThreadInvalidationFilter } from "./hermesInvalidation.ts";

export function createHermesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const threadChanges = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "hermes-work:thread-changes",
    tag: ORCHESTRATION_V2_WS_METHODS.subscribeThread,
    idleTtlMs: 0,
    transform: (stream) =>
      stream.pipe(
        Stream.filter(createHermesThreadInvalidationFilter()),
        Stream.debounce("200 millis"),
      ),
  });
  const workChanges = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "hermes-work:changes",
    tag: WS_METHODS.hermesWorkSubscribeChanges,
    idleTtlMs: 0,
    transform: (stream) => stream.pipe(Stream.debounce("200 millis")),
  });
  const scheduler = createAtomCommandScheduler();
  const providerConcurrency = (command: string) => ({
    mode: "singleFlight" as const,
    key: ({
      environmentId,
      input,
    }: {
      readonly environmentId: string;
      readonly input: { readonly providerInstanceId: string };
    }) => JSON.stringify([command, environmentId, input.providerInstanceId]),
  });

  return {
    workChanges,
    workModelStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "hermes-work:ModelStatus",
      tag: WS_METHODS.hermesWorkModelStatus,
    }),
    workModelAuthStart: createEnvironmentRpcCommand(runtime, {
      label: "hermes-work:ModelAuthStart",
      tag: WS_METHODS.hermesWorkModelAuthStart,
    }),
    workModelAuthPoll: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "hermes-work:ModelAuthPoll",
      tag: WS_METHODS.hermesWorkModelAuthPoll,
    }),
    workModelAuthCancel: createEnvironmentRpcCommand(runtime, {
      label: "hermes-work:ModelAuthCancel",
      tag: WS_METHODS.hermesWorkModelAuthCancel,
    }),
    workModelSet: createEnvironmentRpcCommand(runtime, {
      label: "hermes-work:ModelSet",
      tag: WS_METHODS.hermesWorkModelSet,
    }),
    workSetupStart: createEnvironmentRpcCommand(runtime, {
      label: "hermes-work:setup-start",
      tag: WS_METHODS.hermesWorkSetupStart,
      scheduler,
      concurrency: providerConcurrency("setup"),
    }),
    workSetupStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "hermes-work:setup-status",
      tag: WS_METHODS.hermesWorkSetupStatus,
    }),
    workGroupsQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "hermes-work:groups-query",
      tag: WS_METHODS.hermesWorkGroupsQuery,
    }),
    workGroupsMutate: createEnvironmentRpcCommand(runtime, {
      label: "hermes-work:groups-mutate",
      tag: WS_METHODS.hermesWorkGroupsMutate,
      scheduler,
      concurrency: providerConcurrency("groups-mutate"),
    }),
    workConnections: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "hermes-work:connections",
      tag: WS_METHODS.hermesWorkConnections,
    }),
    workQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "hermes-work:query",
      tag: WS_METHODS.hermesWorkQuery,
      idleTtlMs: 0,
      invalidation: (target) =>
        target.input.section === "thread" && target.input.id
          ? threadChanges({
              environmentId: target.environmentId,
              input: { threadId: ThreadId.make(target.input.id), snapshotMaxVisibleItems: 1 },
            })
          : target.input.providerInstanceId &&
              ["schedules", "runs", "status", "sessions"].includes(target.input.section)
            ? workChanges({
                environmentId: target.environmentId,
                input: { providerInstanceId: target.input.providerInstanceId },
              })
            : undefined,
    }),
    workMutate: createEnvironmentRpcCommand(runtime, {
      label: "hermes-work:mutate",
      tag: WS_METHODS.hermesWorkMutate,
      scheduler,
      concurrency: providerConcurrency("work-mutate"),
    }),
  };
}
