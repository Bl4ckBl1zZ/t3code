import { vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  PullRequestOperationError,
  WS_METHODS,
  AuthSourceControlWriteScope,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createPullRequestEnvironmentAtoms } from "./pullRequests.ts";
import { PullRequestDiffLoader } from "./pullRequestDiffHttp.ts";
import { executeAtomQuery } from "./runtime.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

it.effect("refreshes pull request activity after a comment is updated", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let commentBody = "old comment";
      const client = {
        [WS_METHODS.pullRequestsActivity]: () =>
          Effect.succeed({
            author: null,
            reviewers: [],
            comments: [
              {
                id: "comment-1",
                kind: "issue-comment",
                author: null,
                body: commentBody,
                createdAt: "2026-08-24T00:00:00Z",
                url: null,
                path: null,
                reviewState: null,
                reactions: [],
              },
            ],
            commentCount: 1,
            commentsTruncated: false,
            reviewThreads: [],
            commits: [],
            reactions: [],
          }),
        [WS_METHODS.pullRequestsUpdateComment]: (input: { readonly body: string }) =>
          Effect.sync(() => {
            commentBody = input.body;
          }),
      } as unknown as WsRpcProtocolClient;
      const connectionState: SupervisorConnectionState = {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        network: "online",
        phase: "connected",
        attempt: 1,
        generation: 1,
      };
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(connectionState),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        runStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const runtime = Atom.runtime(
        Layer.merge(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Layer.succeed(
            PullRequestDiffLoader,
            PullRequestDiffLoader.of({ load: () => Effect.die("unused") }),
          ),
        ),
      );
      const atoms = createPullRequestEnvironmentAtoms(runtime);
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const reference = {
        projectId: ProjectId.make("project-1"),
        repository: "acme/web",
        number: 1,
      } as const;
      const activity = atoms.activity({ environmentId: TARGET.environmentId, input: reference });
      const unmount = registry.mount(activity);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));

      const initial = yield* Effect.promise(() => executeAtomQuery(registry, activity));
      expect(AsyncResult.isSuccess(initial)).toBe(true);
      if (!AsyncResult.isSuccess(initial)) {
        return yield* Effect.die("activity did not load");
      }
      expect(initial.value.comments[0]?.body).toBe("old comment");

      const update = yield* Effect.promise(() =>
        atoms.updateComment.run(registry, {
          environmentId: TARGET.environmentId,
          input: { ...reference, commentId: "comment-1", kind: "issue-comment", body: "updated" },
        }),
      );

      expect(AsyncResult.isSuccess(update)).toBe(true);
      expect(
        (yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true })).comments[0]
          ?.body,
      ).toBe("updated");
    }),
  ),
);

const makeTestRuntime = Effect.fn("makeTestRuntime")(function* (client: WsRpcProtocolClient) {
  const connectionState: SupervisorConnectionState = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(connectionState),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    runStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(
        PullRequestDiffLoader,
        PullRequestDiffLoader.of({ load: () => Effect.die("unused") }),
      ),
    ),
  );
  const atoms = createPullRequestEnvironmentAtoms(runtime);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return { atoms, registry };
});

const mergeable = {
  provider: "github",
  state: "open",
  isDraft: false,
  capabilities: { actions: ["merge"] },
  viewerPermissions: { actions: ["merge"] },
};

it.effect("queues merge preparation in the action's lane ahead of later clicks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const calls: string[] = [];
      const client = {
        [WS_METHODS.pullRequestsDetail]: (input: { number: number }) =>
          Effect.gen(function* () {
            calls.push(`detail:${input.number}`);
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return mergeable;
          }),
        [WS_METHODS.pullRequestsStack]: (input: { number: number }) =>
          Effect.sync(() => {
            calls.push(`stack:${input.number}`);
            return null;
          }),
        [WS_METHODS.pullRequestsRunAction]: (input: {
          action: string;
          number: number;
          mergeMethod?: string;
        }) =>
          Effect.sync(() => {
            if (input.action === "merge") expect(input.mergeMethod).toBe("squash");
            expect(input).not.toHaveProperty("prepareMerge");
            calls.push(`${input.action}:${input.number}`);
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const reference = { projectId: ProjectId.make("project-1"), repository: "acme/web" };
      const first = atoms.runAction.run(registry, {
        environmentId: TARGET.environmentId,
        input: {
          ...reference,
          number: 1,
          action: "merge",
          prepareMerge: { stackActions: true, resolveMergeMethod: () => "squash" },
        },
      });
      yield* Deferred.await(started);
      const second = atoms.runAction.run(registry, {
        environmentId: TARGET.environmentId,
        input: { ...reference, number: 2, action: "close" },
      });
      expect(calls).toEqual(["detail:1"]);
      yield* Deferred.succeed(release, undefined);
      const results = yield* Effect.promise(() => Promise.all([first, second]));
      expect(results.every(AsyncResult.isSuccess)).toBe(true);
      expect(calls).toEqual(["detail:1", "stack:1", "merge:1", "close:2"]);
    }),
  ),
);

it.effect.each(["closed", "draft", "permission", "stack", "method"] as const)(
  "rejects an unsafe quick merge with %s and keeps later actions running",
  (reason) =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const client = {
          [WS_METHODS.pullRequestsDetail]: () =>
            Effect.succeed({
              ...mergeable,
              state: reason === "closed" ? "closed" : "open",
              isDraft: reason === "draft",
              viewerPermissions: { actions: reason === "permission" ? [] : ["merge"] },
            }),
          [WS_METHODS.pullRequestsStack]: () => Effect.succeed(reason === "stack" ? {} : null),
          [WS_METHODS.pullRequestsRunAction]: (input: { action: string }) =>
            Effect.sync(() => calls.push(input.action)),
        } as unknown as WsRpcProtocolClient;
        const { atoms, registry } = yield* makeTestRuntime(client);
        const target = {
          environmentId: TARGET.environmentId,
          input: { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 1 },
        };
        const merge = atoms.runAction.run(registry, {
          ...target,
          input: {
            ...target.input,
            action: "merge",
            prepareMerge: {
              stackActions: true,
              resolveMergeMethod: () => {
                if (reason === "method") throw new Error("No merge method is available.");
                return "squash";
              },
            },
          },
        });
        const close = atoms.runAction.run(registry, {
          ...target,
          input: { ...target.input, action: "close" },
        });
        const results = yield* Effect.promise(() => Promise.all([merge, close]));
        expect(results.map((result) => result._tag)).toEqual(["Failure", "Success"]);
        expect(calls).toEqual(["close"]);
      }),
    ),
);

it.effect("keeps a close batch ordered and continues after a refused close", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: number[] = [];
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const client = {
        [WS_METHODS.pullRequestsRunAction]: (input: { number: number; action: string }) =>
          Effect.gen(function* () {
            expect(input.action).toBe("close");
            calls.push(input.number);
            if (input.number === 6) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }
            if (input.number === 5)
              return yield* new PullRequestOperationError({
                operation: "runAction",
                detail: "You cannot close this pull request.",
              });
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const batch = [6, 5, 4].map((number) =>
        atoms.runAction.run(registry, {
          environmentId: TARGET.environmentId,
          input: {
            projectId: ProjectId.make("project-1"),
            repository: "acme/web",
            number,
            action: "close",
          },
        }),
      );
      yield* Deferred.await(started);
      expect(calls).toEqual([6]);
      yield* Deferred.succeed(release, undefined);
      const results = yield* Effect.promise(() => Promise.all(batch));
      expect(results.map((result) => result._tag)).toEqual(["Success", "Failure", "Success"]);
      expect(calls).toEqual([6, 5, 4]);
    }),
  ),
);

// Transport fixtures have a source-control-only session; authorization edge cases
// are exercised by commandPermissions.test.ts.
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: grantedSessions }),
}));
const grantedSessions = Atom.family((_id: EnvironmentId) =>
  Atom.make(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthSourceControlWriteScope],
    }),
  ),
);
