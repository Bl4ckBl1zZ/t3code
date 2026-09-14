import { hermesCreatedScheduleIds } from "./HermesWorkScheduleLinks.ts";
import {
  CommandId,
  HermesWorkError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type HermesWorkMutateInput,
  type HermesWorkQueryInput,
} from "@t3tools/contracts";
import { Context, DateTime, Effect, Layer, Option, Schema, Semaphore } from "effect";
import * as NodeCrypto from "node:crypto";
import { ServerConfig } from "../config.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { HermesDashboardClient } from "./HermesDashboardClient.ts";
import { HermesGatewayClient } from "./HermesGatewayClient.ts";
import { HermesSessionBindingRepository } from "./HermesSessionBindingRepository.ts";

const NativeSession = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  preview: Schema.optional(Schema.NullOr(Schema.String)),
  is_active: Schema.optional(Schema.Boolean),
  last_active: Schema.optional(Schema.NullOr(Schema.Number)),
  started_at: Schema.optional(Schema.NullOr(Schema.Number)),
});
const decodeNativeSession = Schema.decodeUnknownEffect(NativeSession);
const decodeNativeSessions = Schema.decodeUnknownEffect(
  Schema.Struct({ sessions: Schema.Array(NativeSession) }),
);
const decodeProfileRoster = Schema.decodeUnknownEffect(
  Schema.Struct({ profiles: Schema.Array(Schema.Struct({ name: Schema.String })) }),
);
const encodeIdentity = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      providerInstanceId: Schema.String,
      profileKey: Schema.String,
      storedSessionKey: Schema.String,
    }),
  ),
);
const isWorkError = Schema.is(HermesWorkError);
const decodeFailure = () =>
  new HermesWorkError({
    code: "invalid_response",
    message: "Hermes returned an invalid conversation record.",
  });
const workError = (cause: unknown) =>
  isWorkError(cause)
    ? cause
    : new HermesWorkError({
        code: "unavailable",
        message: "The Hermes conversation could not be opened. Reconnect and try again.",
      });

export const makeHermesWorkConversationService = Effect.gen(function* () {
  const dashboard = yield* HermesDashboardClient;
  const bindings = yield* HermesSessionBindingRepository;
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectService;
  const config = yield* ServerConfig;
  const orchestrator = yield* OrchestratorV2;
  const opening = Semaphore.makeUnsafe(1);

  const query = Effect.fn("HermesWorkConversationService.query")(function* (
    input: HermesWorkQueryInput,
  ) {
    const response = yield* dashboard.request({
      providerInstanceId: input.providerInstanceId,
      profile: input.profile,
      method: "GET",
      path: "/api/sessions",
      query: { limit: 100, order: "recent" },
    });
    const result = yield* decodeNativeSessions(response).pipe(Effect.mapError(decodeFailure));
    return result.sessions.map((session) => ({
      id: session.id,
      profile: input.profile,
      title: session.title || "Untitled conversation",
      preview: session.preview || "",
      active: session.is_active === true,
      updatedAt: session.last_active ?? session.started_at ?? null,
    }));
  });

  const open = Effect.fn("HermesWorkConversationService.open")(
    function* (input: HermesWorkMutateInput) {
      if (input.command.type !== "conversation.open")
        return yield* new HermesWorkError({
          code: "invalid_input",
          message: "Choose a conversation to open.",
        });
      const command = input.command;
      if (command.sourceThreadId) {
        const source = yield* bindings.getByThreadId(command.sourceThreadId);
        if (Option.isNone(source) || source.value.providerInstanceId !== input.providerInstanceId)
          return yield* new HermesWorkError({
            code: "not_found",
            message: "The source conversation does not belong to this Hermes connection.",
          });
        input = { ...input, profile: source.value.profileKey };
      }
      if (!config.t3WorkDir)
        return yield* new HermesWorkError({
          code: "unavailable",
          message: "This environment has no Work directory.",
        });
      const foundProject = yield* projects.getByWorkspaceRoot(config.t3WorkDir);
      const project = Option.isSome(foundProject)
        ? foundProject.value
        : (yield* projects.bootstrap({
            commandId: CommandId.make("hermes-work:bootstrap"),
            projectId: ProjectId.make("project:t3-work"),
            title: "T3 Work",
            workspaceRoot: config.t3WorkDir,
            createWorkspaceRootIfMissing: true,
          })).project;
      const provider = yield* dashboard.connection(input.providerInstanceId);
      let storedId = command.sessionId;
      let title = `New conversation · ${input.profile}`;
      if (storedId) {
        const response = yield* dashboard.request({
          providerInstanceId: input.providerInstanceId,
          profile: input.profile,
          method: "GET",
          path: `/api/sessions/${encodeURIComponent(storedId)}`,
        });
        const session = yield* decodeNativeSession(response).pipe(Effect.mapError(decodeFailure));
        storedId = session.id;
        title = session.title || session.preview || "Hermes conversation";
      } else {
        const profiles = yield* dashboard.request({
          providerInstanceId: input.providerInstanceId,
          method: "GET",
          path: "/api/profiles",
        });
        const roster = yield* decodeProfileRoster(profiles).pipe(Effect.mapError(decodeFailure));
        if (!roster.profiles.some((profile) => profile.name === input.profile))
          return yield* new HermesWorkError({
            code: "not_found",
            message: "The selected assistant no longer exists.",
          });
        storedId = yield* Effect.tryPromise({
          try: async () => {
            const client = new HermesGatewayClient({
              endpoint: provider.endpoint,
              authToken: provider.token,
            });
            try {
              await client.connect();
              const session = await client.createSession(
                { profile: input.profile, source: "desktop", title, close_on_disconnect: false },
                { operationId: `t3-work-open:${NodeCrypto.randomUUID()}` },
              );
              return session.stored_session_id;
            } finally {
              client.close();
            }
          },
          catch: workError,
        });
      }
      const identity = {
        providerInstanceId: input.providerInstanceId,
        profileKey: input.profile,
        storedSessionKey: storedId,
      };
      const existing = yield* bindings.getByStoredIdentity(identity);
      const encodedIdentity = yield* encodeIdentity(identity);
      const digest = NodeCrypto.createHash("sha256").update(encodedIdentity).digest("hex");
      const threadId = ThreadId.make(
        Option.isSome(existing) ? existing.value.threadId : `thread:hermes-work:${digest}`,
      );
      if (Option.isNone(existing)) {
        yield* threads.dispatch({
          type: "thread.create",
          createdBy: "system",
          creationSource: "provider",
          commandId: CommandId.make(`hermes-work:${digest}:create`),
          threadId,
          projectId: project.id,
          title,
          modelSelection: {
            instanceId: ProviderInstanceId.make(input.providerInstanceId),
            model: "default",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const created = yield* bindings.createBinding({
          ...identity,
          bindingId: `hermes-work:${digest}`,
          projectId: String(project.id),
          threadId: String(threadId),
          protocolClassification: "supported",
          protocolMajor: null,
          protocolMinor: null,
          capabilities: [],
          reconciliationCursor: null,
          reconciliationFingerprint: null,
          now: DateTime.formatIso(yield* DateTime.now),
        });
        if (!created)
          return yield* new HermesWorkError({
            code: "conflict",
            message: "This conversation was opened elsewhere. Refresh and open it again.",
          });
      }
      if (command.surface)
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`hermes-work:${digest}:surface:${NodeCrypto.randomUUID()}`),
          threadId,
          workInboxRole: command.surface === "chat" ? "chat" : null,
        });
      // Existing conversations hydrate from Hermes before navigation; new empty drafts are
      // retained by the gateway until the first prompt creates their durable native row.
      if (command.sessionId)
        yield* orchestrator.hydrateProviderThreadSnapshot({
          threadId,
          providerInstanceId: ProviderInstanceId.make(input.providerInstanceId),
        });
      return { message: "Conversation opened.", threadId: String(threadId) };
    },
    opening.withPermit,
    Effect.mapError(workError),
  );
  const binding = Effect.fn("HermesWorkConversationService.binding")((threadId: string) =>
    bindings.getByThreadId(threadId).pipe(
      Effect.map(
        Option.map(({ providerInstanceId, profileKey, storedSessionKey }) => ({
          providerInstanceId,
          profileKey,
          storedSessionKey,
        })),
      ),
      Effect.mapError(workError),
    ),
  );
  const createdScheduleIds = Effect.fn("HermesWorkConversationService.createdScheduleIds")(
    (threadId: string) =>
      orchestrator.getThreadProjection(ThreadId.make(threadId)).pipe(
        Effect.map((projection) => hermesCreatedScheduleIds(projection.turnItems)),
        Effect.mapError(workError),
      ),
  );
  return { query, open, binding, createdScheduleIds };
});

export class HermesWorkConversationService extends Context.Service<
  HermesWorkConversationService,
  Effect.Success<typeof makeHermesWorkConversationService>
>()("t3/hermes/HermesWorkConversationService") {}
export const hermesWorkConversationServiceLayer = Layer.effect(
  HermesWorkConversationService,
  makeHermesWorkConversationService,
);
