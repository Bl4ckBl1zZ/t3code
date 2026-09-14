import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { HermesWorkError, HermesWorkRun } from "@t3tools/contracts";
import { HermesDashboardClient, type HermesDashboardRequest } from "./HermesDashboardClient.ts";
import { HermesWorkRunRepository } from "./HermesWorkRunRepository.ts";
import { HermesWorkConversationService } from "./HermesWorkConversationService.ts";
import { makeHermesWorkService } from "./HermesWorkService.ts";

const isWorkError = Schema.is(HermesWorkError);
const make = Effect.fn("test.HermesWorkService.make")(function* (
  respond: (request: HermesDashboardRequest) => unknown,
  bound = false,
  createdIds: string[] = [],
  savedRuns: ReadonlyArray<typeof HermesWorkRun.Type> = [],
) {
  const requests: HermesDashboardRequest[] = [];
  const service = yield* makeHermesWorkService.pipe(
    Effect.provideService(HermesWorkConversationService, {
      binding: () =>
        Effect.succeed(
          bound
            ? Option.some({
                providerInstanceId: "hermes",
                profileKey: "actual-profile",
                storedSessionKey: "native-session",
              })
            : Option.none(),
        ),
      createdScheduleIds: () => Effect.succeed(createdIds),
      query: () => Effect.succeed([]),
      open: () => Effect.succeed({ message: "opened", threadId: "test" }),
    }),
    Effect.provideService(HermesDashboardClient, {
      connections: () => Effect.succeed({ connections: [] }),
      connection: () => Effect.fail(new HermesWorkError({ code: "unavailable", message: "test" })),
      request: (request) =>
        Effect.suspend(() => {
          requests.push(request);
          const result = respond(request);
          return isWorkError(result) ? Effect.fail(result) : Effect.succeed(result);
        }),
    }),
    Effect.provideService(HermesWorkRunRepository, {
      list: () => Effect.succeed(savedRuns),
      upsert: () => Effect.void,
      getResult: () => Effect.succeed(null),
      saveResult: () => Effect.void,
      markRead: () => Effect.void,
      getCursor: () => Effect.succeed({ watermark: 0, offset: 0, nextWatermark: 0 }),
      saveCursor: () => Effect.void,
      pendingResults: () => Effect.succeed([]),
    }),
  );
  return { service, requests };
});
const target = { providerInstanceId: "hermes", profile: "research" };

describe("Hermes Work management", () => {
  it.effect(
    "keeps created tasks and scheduler visible before session persistence, then rereads workspace",
    () =>
      Effect.gen(function* () {
        let persisted = false;
        const { service } = yield* make(
          (request) =>
            request.path.startsWith("/api/sessions/")
              ? persisted
                ? { id: "native-session", cwd: "/native/workspace" }
                : new HermesWorkError({ code: "not_found", message: "Not persisted" })
              : request.path === "/api/cron/jobs"
                ? [{ id: "created", name: "Hourly", schedule: "every 1h" }, { id: "unrelated" }]
                : { gateway_running: true, gateway_state: "running" },
          true,
          ["created"],
        );
        const input = {
          providerInstanceId: "",
          profile: "default",
          section: "thread" as const,
          id: "thread",
        };
        const before = yield* service.query(input);
        expect(before.threadDetails).toMatchObject({
          status: "unavailable",
          workspacePath: null,
          gatewayRunning: true,
          schedules: [{ id: "created", relationship: "created_here" }],
        });
        persisted = true;
        expect((yield* service.query(input)).threadDetails).toMatchObject({
          status: "bound",
          workspacePath: "/native/workspace",
          schedules: [{ id: "created", relationship: "created_here" }],
        });
      }),
  );
  it.effect("reads native workspace using binding identity and excludes unrelated schedules", () =>
    Effect.gen(function* () {
      const { service, requests } = yield* make(
        (request) =>
          request.path.startsWith("/api/sessions/")
            ? { id: "native-session", cwd: "/native/workspace" }
            : { gateway_running: true, gateway_state: "running" },
        true,
      );
      const result = yield* service.query({
        providerInstanceId: "",
        profile: "wrong-profile",
        section: "thread",
        id: "thread",
      });
      expect(result.threadDetails).toMatchObject({
        status: "bound",
        profile: "actual-profile",
        sessionId: "native-session",
        workspacePath: "/native/workspace",
        schedules: [],
        gatewayRunning: true,
      });
      expect(
        requests.every(
          (request) =>
            request.profile === "actual-profile" && request.providerInstanceId === "hermes",
        ),
      ).toBe(true);
      expect(requests.some((request) => request.path === "/api/cron/jobs")).toBe(false);
      const error = yield* service
        .query({ providerInstanceId: "other", profile: "default", section: "thread", id: "thread" })
        .pipe(Effect.flip);
      expect(error.code).toBe("invalid_input");
    }),
  );
  it.effect("keeps unbound and unavailable thread details distinct", () =>
    Effect.gen(function* () {
      const empty = yield* make(() => ({}));
      const input = {
        providerInstanceId: "",
        profile: "default",
        section: "thread" as const,
        id: "thread",
      };
      expect((yield* empty.service.query(input)).threadDetails?.status).toBe("unbound");
      expect(empty.requests).toHaveLength(0);
      const offline = yield* make(
        () => new HermesWorkError({ code: "unavailable", message: "Offline" }),
        true,
      );
      expect((yield* offline.service.query(input)).threadDetails).toMatchObject({
        status: "unavailable",
        sessionId: "native-session",
        workspacePath: null,
      });
    }),
  );
  it.effect("creates and updates native schedules through the authoritative REST endpoint", () =>
    Effect.gen(function* () {
      const { service, requests } = yield* make(() => ({ id: "job" }));
      yield* service.mutate({
        ...target,
        command: {
          type: "schedule.create",
          name: "Hourly",
          prompt: "Check changes",
          schedule: "every 1h",
          deliver: "local",
          contextFrom: ["previous"],
        },
      });
      yield* service.mutate({
        ...target,
        command: {
          type: "schedule.update",
          id: "job/one",
          name: "Hourly",
          prompt: "Check changes",
          schedule: "every 2h",
          deliver: "local",
        },
      });
      expect(requests).toEqual([
        {
          ...target,
          method: "POST",
          path: "/api/cron/jobs",
          body: {
            name: "Hourly",
            prompt: "Check changes",
            schedule: "every 1h",
            deliver: "local",
            context_from: ["previous"],
          },
        },
        {
          ...target,
          method: "PUT",
          path: "/api/cron/jobs/job%2Fone",
          body: {
            updates: {
              name: "Hourly",
              prompt: "Check changes",
              schedule: "every 2h",
              deliver: "local",
            },
          },
        },
      ]);
    }),
  );
  it.effect("preserves canonical one-shot schedule input instead of its display label", () =>
    Effect.gen(function* () {
      const { service } = yield* make(() => [
        {
          id: "job",
          schedule: { kind: "once", run_at: "2026-09-15T10:00:00+02:00" },
          schedule_display: "once at tomorrow",
        },
      ]);
      const result = yield* service.query({ ...target, section: "schedules" });
      expect(result.schedules[0]?.schedule).toBe("2026-09-15T10:00:00+02:00");
    }),
  );
  it.effect("handles a never-started gateway without presenting it as running", () =>
    Effect.gen(function* () {
      const { service } = yield* make(() => ({ gateway_running: false, gateway_state: null }));
      const result = yield* service.query({ ...target, section: "status" });
      expect(result).toMatchObject({ gatewayRunning: false, gatewayState: "stopped" });
    }),
  );
  it.effect("resolves memory under the selected profile and refuses a stale overwrite", () =>
    Effect.gen(function* () {
      const { service, requests } = yield* make((request) =>
        request.path === "/api/profiles"
          ? { profiles: [{ name: "research", path: "/profiles/research" }] }
          : { text: "changed", truncated: false },
      );
      const error = yield* service
        .mutate({
          ...target,
          command: {
            type: "memory.save",
            file: "MEMORY.md",
            expectedContent: "old",
            content: "replacement",
          },
        })
        .pipe(Effect.flip);
      expect(error.code).toBe("conflict");
      expect(requests).toHaveLength(2);
      expect(requests[1]?.query).toEqual({ path: "/profiles/research/memories/MEMORY.md" });
    }),
  );
  it.effect("opens an absent memory file as an empty editor", () =>
    Effect.gen(function* () {
      const { service } = yield* make((request) =>
        request.path === "/api/profiles"
          ? { profiles: [{ name: "research", path: "/profiles/research" }] }
          : new HermesWorkError({ code: "not_found", message: "File not found" }),
      );
      const result = yield* service.query({ ...target, section: "memory" });
      expect(result).toMatchObject({ content: "", path: "/profiles/research/memories/MEMORY.md" });
    }),
  );
  it.effect("preserves saved delivery state when native run metadata refreshes", () =>
    Effect.gen(function* () {
      const saved = {
        id: "cron_job_1",
        profile: "research",
        title: "Hourly",
        startedAt: 100,
        endedAt: 120,
        active: false,
        jobId: "job",
        status: "completed",
        deliveryStatus: "delivered",
        content: "saved output",
        readAt: "2026-09-14T00:00:00Z",
      };
      const { service } = yield* make(
        () => ({
          runs: [{ id: "cron_job_1", ended_at: 123, is_active: false }],
        }),
        false,
        [],
        [saved],
      );
      const result = yield* service.query({ ...target, section: "runs", id: "job" });
      expect(result.runs[0]).toMatchObject({
        deliveryStatus: "delivered",
        content: "saved output",
        readAt: saved.readAt,
        endedAt: 123,
      });
    }),
  );
  it.effect("does not infer execution success from an ended timestamp", () =>
    Effect.gen(function* () {
      const { service } = yield* make(() => ({
        runs: [{ id: "cron_job_1", ended_at: 123, is_active: false }],
      }));
      const result = yield* service.query({ ...target, section: "runs", id: "job" });
      expect(result.runs[0]).toMatchObject({ status: null, deliveryStatus: null, endedAt: 123 });
    }),
  );
});
