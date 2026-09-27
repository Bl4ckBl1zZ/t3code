import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  type ProviderAuthState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import {
  ProviderAuthService,
  type ProviderAuthController,
} from "../Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderAuthServiceLive } from "./ProviderAuthService.ts";

const personal = ProviderInstanceId.make("cursor-personal");
const work = ProviderInstanceId.make("cursor-work");
const other = ProviderInstanceId.make("cursor-other");

const idle = (instanceId: ProviderInstanceId): ProviderAuthState => ({
  instanceId,
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
});

function makeController(
  instanceId: ProviderInstanceId,
  options: {
    readonly key?: string;
    readonly changing?: boolean;
    readonly events: Array<string>;
  },
): ProviderAuthController {
  const unused = () => Effect.die("unused auth operation");
  return {
    ...(options.key ? { credentialBinding: { owner: "t3" as const, key: options.key } } : {}),
    isChangingCredentials: Effect.succeed(options.changing === true),
    invalidate: Effect.sync(() => {
      options.events.push(`invalidate:${instanceId}`);
    }),
    start: (_owner, stopSessions = Effect.void, methodId) =>
      stopSessions.pipe(
        Effect.tap(() => Effect.sync(() => options.events.push(`start:${methodId ?? "default"}`))),
        Effect.as({ ...idle(instanceId), phase: "starting" as const }),
      ),
    complete: unused,
    cancel: unused,
    logout: (stopSessions) => stopSessions.pipe(Effect.as(idle(instanceId))),
    subscribe: () => Stream.empty,
  };
}

function makeLayer(instances: ReadonlyArray<ProviderInstance>, events: Array<string>) {
  return ProviderAuthServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry)({
          getInstance: (id) =>
            Effect.succeed(instances.find((instance) => instance.instanceId === id)),
          listInstances: Effect.succeed(instances),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          closeInstance: (id) =>
            Effect.sync(() => {
              events.push(`close:${id}`);
            }),
        }),
      ),
    ),
  );
}

const instance = (instanceId: ProviderInstanceId, auth: ProviderAuthController) =>
  ({
    instanceId,
    driverKind: ProviderDriverKind.make("cursor"),
    auth,
  }) as unknown as ProviderInstance;

it.effect("signing in stops and invalidates every instance sharing the credential", () => {
  const events: Array<string> = [];
  const instances = [
    instance(personal, makeController(personal, { key: "shared", events })),
    instance(work, makeController(work, { key: "shared", events })),
    instance(other, makeController(other, { key: "separate", events })),
  ];
  return Effect.gen(function* () {
    const auth = yield* ProviderAuthService;
    yield* auth.start({ instanceId: personal, methodId: "browser" }, "owner");
    assert.deepEqual(events, [
      `close:${personal}`,
      `close:${work}`,
      `invalidate:${work}`,
      "start:browser",
    ]);
  }).pipe(Effect.provide(makeLayer(instances, events)));
});

it.effect("refuses to change a shared credential while a peer is changing it", () => {
  const events: Array<string> = [];
  const instances = [
    instance(personal, makeController(personal, { key: "shared", events })),
    instance(work, makeController(work, { key: "shared", changing: true, events })),
  ];
  return Effect.gen(function* () {
    const auth = yield* ProviderAuthService;
    const error = yield* auth.start({ instanceId: personal }, "owner").pipe(Effect.flip);
    assert.instanceOf(error, ProviderSetupError);
    assert.include(error.detail, "shared sign-in");
    assert.deepEqual(events, []);
  }).pipe(Effect.provide(makeLayer(instances, events)));
});

it.effect("rejects a response for a provider without interactive sign-in", () => {
  const events: Array<string> = [];
  const instances = [instance(personal, makeController(personal, { events }))];
  return Effect.gen(function* () {
    const auth = yield* ProviderAuthService;
    const error = yield* auth
      .respond(
        {
          instanceId: personal,
          flowId: "flow",
          interactionId: "interaction",
          response: { type: "browser", action: "accept" },
        },
        "owner",
      )
      .pipe(Effect.flip);
    assert.include(error.detail, "does not accept");
  }).pipe(Effect.provide(makeLayer(instances, events)));
});
