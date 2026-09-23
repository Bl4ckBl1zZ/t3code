import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProviderAuthService from "../Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";

type CredentialBinding = ProviderAuthService.ProviderAuthController["credentialBinding"];

const sameBinding = (
  auth: ProviderAuthService.ProviderAuthController | undefined,
  binding: NonNullable<CredentialBinding>,
) => auth?.credentialBinding?.key === binding.key && auth.credentialBinding.owner === binding.owner;

export const makeProviderAuthService = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const sessions = yield* ProviderSessionManagerV2;
  const credentialChanges = yield* Semaphore.make(1);

  const getController = Effect.fn("ProviderAuthService.getController")(function* (
    instanceId: ProviderInstanceId,
    operation: string,
  ) {
    const instance = yield* registry.getInstance(instanceId);
    if (!instance?.auth) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: instance
          ? "This provider does not support sign-in in T3 Code."
          : "This provider instance is no longer available.",
      });
    }
    return instance.auth;
  });

  // A credential change stops the live sessions of every instance that shares
  // the credential, then tells those peers their sign-in changed.
  const stopSessions = Effect.fn("ProviderAuthService.stopSessions")(function* (
    instanceId: ProviderInstanceId,
    binding: CredentialBinding,
  ) {
    const peers =
      binding === undefined
        ? []
        : (yield* registry.listInstances).filter(
            (instance) => instance.instanceId !== instanceId && sameBinding(instance.auth, binding),
          );
    yield* Effect.forEach(
      [instanceId, ...peers.map((peer) => peer.instanceId)],
      (affected) =>
        sessions.closeInstance(affected).pipe(
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId,
                operation: "stopSessions",
                detail: "Could not stop all sessions for this provider. Try again.",
              }),
          ),
        ),
      { discard: true },
    );
    yield* Effect.forEach(peers, (peer) => peer.auth?.invalidate ?? Effect.void, {
      discard: true,
    });
  });

  const checkSharedBinding = Effect.fnUntraced(function* (
    instanceId: ProviderInstanceId,
    operation: "start" | "logout",
    auth: ProviderAuthService.ProviderAuthController,
  ) {
    const binding = auth.credentialBinding;
    if (!binding) return;
    for (const instance of yield* registry.listInstances) {
      if (
        instance.instanceId !== instanceId &&
        sameBinding(instance.auth, binding) &&
        instance.auth?.isChangingCredentials &&
        (yield* instance.auth.isChangingCredentials)
      ) {
        return yield* new ProviderSetupError({
          instanceId,
          operation,
          detail:
            "Another provider instance is changing this shared sign-in. Finish or cancel it first.",
        });
      }
    }
  });

  return ProviderAuthService.ProviderAuthService.of({
    start: Effect.fn("ProviderAuthService.start")(function* (input, ownerSessionId) {
      return yield* credentialChanges.withPermit(
        Effect.gen(function* () {
          const auth = yield* getController(input.instanceId, "start");
          yield* checkSharedBinding(input.instanceId, "start", auth);
          return yield* auth.start(
            ownerSessionId,
            stopSessions(input.instanceId, auth.credentialBinding),
            input.methodId,
          );
        }),
      );
    }),
    respond: Effect.fn("ProviderAuthService.respond")(function* (input, ownerSessionId) {
      const auth = yield* getController(input.instanceId, "respond");
      if (!auth.respond) {
        return yield* new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "respond",
          detail: "This provider does not accept this sign-in interaction.",
        });
      }
      return yield* auth.respond(ownerSessionId, input);
    }),
    complete: Effect.fn("ProviderAuthService.complete")(function* (input, ownerSessionId) {
      const auth = yield* getController(input.instanceId, "complete");
      return yield* auth.complete(ownerSessionId, input);
    }),
    cancel: Effect.fn("ProviderAuthService.cancel")(function* (input, ownerSessionId) {
      const auth = yield* getController(input.instanceId, "cancel");
      return yield* auth.cancel(ownerSessionId, input.flowId);
    }),
    logout: Effect.fn("ProviderAuthService.logout")(function* (input) {
      return yield* credentialChanges.withPermit(
        Effect.gen(function* () {
          const auth = yield* getController(input.instanceId, "logout");
          yield* checkSharedBinding(input.instanceId, "logout", auth);
          return yield* auth.logout(stopSessions(input.instanceId, auth.credentialBinding));
        }),
      );
    }),
    subscribe: (input, ownerSessionId) =>
      Effect.gen(function* () {
        const changes = yield* registry.subscribeChanges;
        const initial = yield* getController(input.instanceId, "subscribe");
        return Stream.concat(
          Stream.succeed(initial),
          Stream.fromSubscription(changes).pipe(
            Stream.mapEffect(() => getController(input.instanceId, "subscribe")),
          ),
        ).pipe(
          Stream.changesWith((previous, next) => previous === next),
          Stream.switchMap((auth) => auth.subscribe(ownerSessionId)),
        );
      }).pipe(Stream.unwrap),
    tryHandlePromptCommand: Effect.fn("ProviderAuthService.tryHandlePromptCommand")(
      function* (input) {
        const instance = yield* registry.getInstance(input.instanceId);
        if (!instance?.auth?.isLogoutPrompt?.(input.text, input.hasAttachments)) {
          return false;
        }
        return yield* credentialChanges.withPermit(
          Effect.gen(function* () {
            const auth = yield* getController(input.instanceId, "logout");
            if (!auth.isLogoutPrompt?.(input.text, input.hasAttachments)) return false;
            yield* checkSharedBinding(input.instanceId, "logout", auth);
            yield* auth.logout(stopSessions(input.instanceId, auth.credentialBinding));
            return true;
          }),
        );
      },
    ),
  });
});

export const ProviderAuthServiceLive = Layer.effect(
  ProviderAuthService.ProviderAuthService,
  makeProviderAuthService,
);
