import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AgentAwarenessRelay from "./AgentAwarenessRelay.ts";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const instanceId = ProviderInstanceId.make("codex");

function makeProject(at: string): Project {
  return {
    id: projectId,
    title: "T3 Code",
    workspaceRoot: "/workspace",
    defaultModelSelection: null,
    scripts: [],
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
}

function makeThread(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  const at = DateTime.makeUnsafe("2026-05-24T00:00:00.000Z");
  return {
    id: threadId,
    projectId,
    title: "Task",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeMemorySecretStore(): ServerSecretStore.ServerSecretStore["Service"] {
  const values = new Map<string, Uint8Array>();
  return {
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused secret-store operation"),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  };
}

describe("resolveAgentAwarenessRelayActiveThreadIds", () => {
  it("only replays terminal runs that finished after startup", () => {
    const startedAt = DateTime.makeUnsafe("2026-05-25T00:00:00.000Z");
    const before = DateTime.subtract(startedAt, { days: 1 });
    const after = DateTime.add(startedAt, { seconds: 2 });

    expect(
      AgentAwarenessRelay.resolveAgentAwarenessRelayActiveThreadIds({
        environmentId,
        startedAt: startedAt.epochMilliseconds,
        projects: [makeProject("2026-05-24T00:00:00.000Z")],
        threads: [
          makeThread("running", { status: "running" }),
          makeThread("idle"),
          makeThread("old-completed", { status: "completed", latestRunCompletedAt: before }),
          makeThread("old-failed", { status: "failed", latestRunCompletedAt: before }),
          makeThread("new-completed", { status: "completed", latestRunCompletedAt: after }),
          makeThread("unknown-completion", { status: "completed" }),
        ],
      }),
    ).toEqual([ThreadId.make("running"), ThreadId.make("new-completed")]);
  });
});

describe("AgentAwarenessRelay.publishThread", () => {
  it.effect("keeps historical terminal runs quiet and alerts on new ones", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const old = DateTime.subtract(now, { days: 7 });
        const threadId = ThreadId.make("thread-1");
        let currentThread = makeThread(threadId, {
          status: "completed",
          latestRunCompletedAt: old,
        });
        let publishes = 0;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (() => {
          publishes += 1;
          return Promise.resolve(Response.json({ ok: true, deliveries: [] }));
        }) as unknown as typeof fetch;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            globalThis.fetch = originalFetch;
          }),
        );

        const secrets = makeMemorySecretStore();
        const encode = (value: string) => new TextEncoder().encode(value);
        yield* secrets.set(RELAY_URL_SECRET, encode("https://relay.example.test"));
        yield* secrets.set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, encode("relay-credential"));
        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, encode("true"));

        const dependencies = Layer.mergeAll(
          Layer.succeed(ServerSecretStore.ServerSecretStore, secrets),
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.die("unused descriptor"),
          }),
          Layer.succeed(ThreadManagement.ThreadManagementService, {
            getThreadShell: () => Effect.sync(() => currentThread),
          } as unknown as ThreadManagement.ThreadManagementService["Service"]),
          Layer.succeed(ProjectService.ProjectService, {
            getById: () => Effect.succeed(Option.some(makeProject(DateTime.formatIso(old)))),
          } as unknown as ProjectService.ProjectService["Service"]),
        );

        yield* Effect.gen(function* () {
          const relay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
          yield* relay.publishThread(threadId);
          expect(publishes).toBe(0);

          currentThread = { ...currentThread, status: "failed" };
          yield* relay.publishThread(threadId);
          expect(publishes).toBe(0);

          currentThread = {
            ...currentThread,
            latestRunCompletedAt: DateTime.add(now, { seconds: 1 }),
          };
          yield* relay.publishThread(threadId);
          expect(publishes).toBe(1);
        }).pipe(
          Effect.provide(
            AgentAwarenessRelay.layer.pipe(
              Layer.provide(dependencies),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
      }),
    ),
  );
});
