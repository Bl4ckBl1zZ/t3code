import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import { Effect, Option } from "effect";
import { ServerConfig } from "../config.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { HermesDashboardClient, type HermesDashboardRequest } from "./HermesDashboardClient.ts";
import { HermesSessionBindingRepository } from "./HermesSessionBindingRepository.ts";
import { makeHermesWorkConversationService } from "./HermesWorkConversationService.ts";

function fixture(response: unknown) {
  const requests: HermesDashboardRequest[] = [];
  const hydrated: string[] = [];
  const service = makeHermesWorkConversationService.pipe(
    Effect.provideService(HermesDashboardClient, {
      request: (input) =>
        Effect.sync(() => {
          requests.push(input);
          return response;
        }),
      connection: () =>
        Effect.succeed({
          providerInstanceId: "hermes",
          endpoint: "ws://localhost",
          token: "token",
          profileKey: "default",
          displayName: "Hermes",
          settings: {} as never,
        }),
      connections: () => Effect.succeed({ connections: [] }),
    }),
    Effect.provideService(HermesSessionBindingRepository, {
      getByThreadId: () =>
        Effect.succeed(
          Option.some({
            threadId: "source-thread",
            profileKey: "research",
            providerInstanceId: "hermes",
          }),
        ),
      getByStoredIdentity: () => Effect.succeed(Option.some({ threadId: "existing-thread" })),
    } as unknown as HermesSessionBindingRepository["Service"]),
    Effect.provideService(ProjectService, {
      getByWorkspaceRoot: () =>
        Effect.succeed(Option.some({ id: ProjectId.make("project:t3-work") })),
    } as unknown as ProjectService["Service"]),
    Effect.provideService(ThreadManagementService, {} as ThreadManagementService["Service"]),
    Effect.provideService(ServerConfig, { t3WorkDir: "/work" } as ServerConfig["Service"]),
    Effect.provideService(OrchestratorV2, {
      hydrateProviderThreadSnapshot: ({ threadId }: { threadId: string }) =>
        Effect.sync(() => {
          hydrated.push(threadId);
        }),
    } as unknown as OrchestratorV2["Service"]),
  );
  return { service, requests, hydrated };
}

describe("Hermes Work conversations", () => {
  it.effect("discovers all native sources in the selected profile without importing them", () =>
    Effect.gen(function* () {
      const f = fixture({
        sessions: [
          {
            id: "cli-session",
            title: "From CLI",
            preview: "hello",
            last_active: 123,
            is_active: true,
          },
        ],
      });
      const result = yield* Effect.gen(function* () {
        const service = yield* f.service;
        return yield* service.query({
          providerInstanceId: "hermes",
          profile: "research",
          section: "sessions",
        });
      });
      expect(result).toEqual([
        {
          id: "cli-session",
          profile: "research",
          title: "From CLI",
          preview: "hello",
          updatedAt: 123,
          active: true,
        },
      ]);
      expect(f.requests[0]).toMatchObject({
        profile: "research",
        path: "/api/sessions",
        query: { order: "recent", limit: 100 },
      });
    }),
  );

  it.effect(
    "reuses the bound thread and hydrates it after verifying native profile ownership",
    () =>
      Effect.gen(function* () {
        const f = fixture({ id: "native-id", title: "Existing" });
        const result = yield* Effect.gen(function* () {
          const service = yield* f.service;
          return yield* service.open({
            providerInstanceId: "hermes",
            profile: "research",
            command: { type: "conversation.open", sessionId: "native-id" },
          });
        });
        expect(result.threadId).toBe("existing-thread");
        expect(f.requests).toEqual([
          {
            providerInstanceId: "hermes",
            profile: "research",
            method: "GET",
            path: "/api/sessions/native-id",
          },
        ]);
        expect(f.hydrated).toEqual(["existing-thread"]);
      }),
  );

  it.effect("inherits the source thread assistant for a follow-up conversation", () =>
    Effect.gen(function* () {
      const f = fixture({ id: "native-id", title: "Existing" });
      yield* Effect.gen(function* () {
        const service = yield* f.service;
        return yield* service.open({
          providerInstanceId: "hermes",
          profile: "default",
          command: {
            type: "conversation.open",
            sourceThreadId: "source-thread",
            sessionId: "native-id",
          },
        });
      });
      expect(f.requests[0]?.profile).toBe("research");
    }),
  );

  it.effect("does not attach an unverified or malformed native conversation", () =>
    Effect.gen(function* () {
      const f = fixture({ title: "Wrong response" });
      const error = yield* Effect.gen(function* () {
        const service = yield* f.service;
        return yield* service.open({
          providerInstanceId: "hermes",
          profile: "research",
          command: { type: "conversation.open", sessionId: "native-id" },
        });
      }).pipe(Effect.flip);
      expect(error.code).toBe("invalid_response");
      expect(f.hydrated).toEqual([]);
    }),
  );
});
