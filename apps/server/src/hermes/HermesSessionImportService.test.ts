import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  HERMES_IMPORT_TRANSPORT_SOURCES,
  classifyHermesImportedSession,
  hermesImportCapabilityError,
  isHermesImportTransportSource,
  isHermesSessionWithinImportAge,
  make,
} from "./HermesSessionImportService.ts";
import {
  HermesSessionBindingRepository,
  type HermesSessionImport,
} from "./HermesSessionBindingRepository.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ServerConfig } from "../config.ts";

const TEST_T3_WORK_DIRECTORY = "/test/t3-work";

/**
 * Fixed wall-clock instant the TestClock is advanced to so `started_at`
 * fixtures can be positive absolute epochs (the import flow rejects
 * non-positive upstream timestamps).
 */
const TEST_NOW_MILLIS = Date.UTC(2026, 6, 26, 12);
const TEST_NOW_SECONDS = TEST_NOW_MILLIS / 1_000;
const advanceToTestNow = TestClock.adjust(Duration.millis(TEST_NOW_MILLIS));

const testProjectService = (projectId: ProjectId) =>
  ProjectService.of({
    getByWorkspaceRoot: () =>
      Effect.succeed(
        Option.some({
          id: projectId,
          workspaceRoot: TEST_T3_WORK_DIRECTORY,
        } as never),
      ),
  } as never);

const testServerConfig = ServerConfig.of({
  t3WorkDir: TEST_T3_WORK_DIRECTORY,
} as never);

describe("Hermes transport session import policy", () => {
  it("recognizes every pinned built-in messaging transport without importing local surfaces", () => {
    expect(HERMES_IMPORT_TRANSPORT_SOURCES).toContain("discord");
    expect(HERMES_IMPORT_TRANSPORT_SOURCES).toContain("telegram");
    expect(HERMES_IMPORT_TRANSPORT_SOURCES).toContain("slack");
    expect(HERMES_IMPORT_TRANSPORT_SOURCES).toContain("whatsapp");
    expect(HERMES_IMPORT_TRANSPORT_SOURCES).toContain("matrix");
    expect(isHermesImportTransportSource(" Discord ")).toBe(true);
    expect(isHermesImportTransportSource("tui")).toBe(false);
    expect(isHermesImportTransportSource("cli")).toBe(false);
    expect(isHermesImportTransportSource("local")).toBe(false);
    expect(isHermesImportTransportSource("custom-unverified-source")).toBe(false);
  });

  it("keeps the inclusive 72-hour boundary unsettled and settles only older sessions", () => {
    const now = Date.UTC(2026, 6, 26, 12);
    const cutoffSeconds = (now - 72 * 60 * 60 * 1_000) / 1_000;

    expect(classifyHermesImportedSession(cutoffSeconds, now)).toBe("unsettled");
    expect(classifyHermesImportedSession(cutoffSeconds + 1, now)).toBe("unsettled");
    expect(classifyHermesImportedSession(cutoffSeconds - 1, now)).toBe("settled");
  });

  it("keeps the inclusive selected-age boundary and rejects older timestamps", () => {
    const now = Date.UTC(2026, 6, 26, 12);
    const cutoffSeconds = (now - 24 * 60 * 60 * 1_000) / 1_000;

    expect(isHermesSessionWithinImportAge(cutoffSeconds, 1, now)).toBe(true);
    expect(isHermesSessionWithinImportAge(cutoffSeconds + 1, 1, now)).toBe(true);
    expect(isHermesSessionWithinImportAge(cutoffSeconds - 1, 1, now)).toBe(false);
  });

  it("requires the session methods import actually spends, and nothing more", () => {
    expect(
      hermesImportCapabilityError({
        status: "legacy",
        protocol: null,
        capabilities: [],
        inventory: null,
        reason: "no negotiation",
      }),
    ).toContain("session.lifecycle");
    expect(
      hermesImportCapabilityError({
        status: "supported",
        protocol: { major: 1, minor: 0 },
        capabilities: ["session.lifecycle"],
        inventory: ["session.lifecycle"],
        reason: "partial negotiation",
      }),
    ).toContain("session.history");
    // A gateway that advertises nothing but proved both methods is enough:
    // there is no `profile.import` method in Hermes to hold out for.
    expect(
      hermesImportCapabilityError({
        status: "legacy",
        protocol: null,
        capabilities: ["session.lifecycle", "session.history"],
        inventory: null,
        reason: "legacy",
      }),
    ).toBeNull();
    expect(
      hermesImportCapabilityError({
        status: "supported",
        protocol: { major: 1, minor: 0 },
        capabilities: ["session.lifecycle", "session.history"],
        inventory: ["session.lifecycle", "session.history"],
        reason: "complete negotiation",
      }),
    ).toBeNull();
  });

  it("reports the negotiated reason when the protocol is unsupported despite a full inventory", () => {
    expect(
      hermesImportCapabilityError({
        status: "unsupported",
        protocol: { major: 9, minor: 0 },
        capabilities: ["session.lifecycle", "session.history"],
        inventory: ["session.lifecycle", "session.history"],
        reason: "gateway protocol 9.0 is newer than this build supports",
      }),
    ).toBe("gateway protocol 9.0 is newer than this build supports");
    expect(
      hermesImportCapabilityError({
        status: "unsupported",
        protocol: null,
        capabilities: ["session.lifecycle", "session.history"],
        inventory: ["session.lifecycle", "session.history"],
        reason: "   ",
      }),
    ).toContain("unsupported");
  });

  effectIt.effect("rejects discovery when profile import is disabled at the server boundary", () =>
    Effect.gen(function* () {
      const registry = ProviderInstanceRegistry.of({
        getInstance: () =>
          Effect.succeed({
            driverKind: ProviderDriverKind.make("hermes"),
            hermesSessionCatalog: {
              profileKey: "disabled-profile",
              importEnabled: false,
            },
          } as never),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      });
      const service = yield* make.pipe(
        Effect.provideService(ProviderInstanceRegistry, registry),
        Effect.provideService(HermesSessionBindingRepository, {} as never),
        Effect.provideService(ThreadManagementService, {} as never),
        Effect.provideService(
          ProjectService,
          testProjectService(ProjectId.make("internal-work-backing")),
        ),
        Effect.provideService(ServerConfig, testServerConfig),
      );
      const error = yield* Effect.flip(
        service.discover({ providerInstanceId: ProviderInstanceId.make("hermes-disabled") }),
      );
      expect(error.message).toContain("disabled");
    }),
  );

  effectIt.effect(
    "imports only transport sessions, settles old shells, and replays as already imported",
    () =>
      Effect.gen(function* () {
        const providerInstanceId = ProviderInstanceId.make("hermes-work");
        const profileKey = "private-work";
        yield* advanceToTestNow;
        const recentSeconds = TEST_NOW_SECONDS;
        const imports = new Map<string, HermesSessionImport>();
        const bindings = new Set<string>();
        const commands: OrchestrationV2Command[] = [];

        const repository = {
          getSessionImportByStoredIdentity: (identity: { readonly storedSessionKey: string }) =>
            Effect.succeed(
              Option.fromUndefinedOr(
                [...imports.values()].find(
                  (row) => row.storedSessionKey === identity.storedSessionKey,
                ),
              ),
            ),
          getMainSessionImport: () =>
            Effect.succeed(
              Option.fromUndefinedOr(
                [...imports.values()].find((row) => row.importKind === "main"),
              ),
            ),
          prepareSessionImport: (input: {
            readonly importId: string;
            readonly providerInstanceId: string;
            readonly profileKey: string;
            readonly projectId: string;
            readonly importKind: "session" | "main";
            readonly storedSessionKey: string | null;
            readonly threadId: string;
            readonly now: string;
          }) =>
            Effect.sync(() => {
              const existing = [...imports.values()].find(
                (row) =>
                  row.providerInstanceId === input.providerInstanceId &&
                  row.profileKey === input.profileKey &&
                  row.importKind === input.importKind &&
                  row.storedSessionKey === input.storedSessionKey,
              );
              if (existing) return existing;
              const row: HermesSessionImport = {
                ...input,
                inheritedMessageCount: null,
                state: "prepared",
                createdAt: input.now,
                updatedAt: input.now,
              };
              imports.set(row.importId, row);
              return row;
            }),
          transitionSessionImport: (input: {
            readonly importId: string;
            readonly to: "thread_created" | "completed";
            readonly now: string;
          }) =>
            Effect.sync(() => {
              const row = imports.get(input.importId);
              if (!row) return false;
              imports.set(input.importId, { ...row, state: input.to, updatedAt: input.now });
              return true;
            }),
          getByStoredIdentity: (identity: { readonly storedSessionKey: string }) =>
            Effect.succeed(
              bindings.has(identity.storedSessionKey)
                ? Option.some({ storedSessionKey: identity.storedSessionKey })
                : Option.none(),
            ),
          createBinding: (input: { readonly storedSessionKey: string }) =>
            Effect.sync(() => {
              if (bindings.has(input.storedSessionKey)) return false;
              bindings.add(input.storedSessionKey);
              return true;
            }),
        } as unknown as HermesSessionBindingRepository["Service"];
        const registry = ProviderInstanceRegistry.of({
          getInstance: () =>
            Effect.succeed({
              driverKind: ProviderDriverKind.make("hermes"),
              hermesSessionCatalog: {
                profileKey,
                importEnabled: true,
                list: () =>
                  Effect.succeed({
                    providerInstanceId,
                    profileKey,
                    compatibility: {
                      status: "supported",
                      protocol: { major: 1, minor: 0 },
                      capabilities: ["session.lifecycle", "session.history"],
                      inventory: ["session.lifecycle", "session.history"],
                      reason: "test negotiation",
                    },
                    sessions: [
                      {
                        id: "discord-recent",
                        title: "Recent Discord",
                        preview: "",
                        started_at: recentSeconds,
                        message_count: 2,
                        source: "discord",
                      },
                      {
                        id: "telegram-old",
                        title: "Old Telegram",
                        preview: "",
                        started_at: TEST_NOW_SECONDS - 73 * 60 * 60,
                        message_count: 4,
                        source: "telegram",
                      },
                      {
                        id: "local-code",
                        title: "Local code",
                        preview: "",
                        started_at: recentSeconds,
                        message_count: 1,
                        source: "tui",
                      },
                    ],
                  }),
              },
            } as never),
          listInstances: Effect.succeed([]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.never,
        });
        const threadManagement = {
          dispatch: (command: OrchestrationV2Command) =>
            Effect.sync(() => {
              commands.push(command);
              return {} as never;
            }),
        } as unknown as ThreadManagementService["Service"];

        const service = yield* make.pipe(
          Effect.provideService(ProviderInstanceRegistry, registry),
          Effect.provideService(HermesSessionBindingRepository, repository),
          Effect.provideService(ThreadManagementService, threadManagement),
          Effect.provideService(
            ProjectService,
            testProjectService(ProjectId.make("internal-work-backing")),
          ),
          Effect.provideService(ServerConfig, testServerConfig),
        );
        const input = {
          providerInstanceId,
          backingProjectId: ProjectId.make("internal-work-backing"),
          selection: { type: "all" as const },
          activeWithinDays: 7,
        };

        const first = yield* service.importSessions(input);
        const replay = yield* service.importSessions(input);
        const forgedProjectError = yield* Effect.flip(
          service.importSessions({
            ...input,
            backingProjectId: ProjectId.make("project:other-environment"),
          }),
        );

        expect(first.imported.map((item) => [item.storedSessionId, item.settlement])).toEqual([
          ["discord-recent", "unsettled"],
          ["telegram-old", "settled"],
        ]);
        expect(replay.imported.map((item) => item.status)).toEqual([
          "already_imported",
          "already_imported",
        ]);
        expect(commands.filter((command) => command.type === "thread.create")).toHaveLength(3);
        const settles = commands.filter((command) => command.type === "thread.settle");
        expect(settles).toHaveLength(1);
        // Settled imports carry the upstream started_at, not the import time,
        // so sidebar age labels stay historical.
        expect(settles[0]).toMatchObject({ settledAt: expect.stringMatching(/^\d{4}-/) });
        expect(bindings).toEqual(new Set(["discord-recent", "telegram-old"]));
        expect(forgedProjectError.message).toContain("this environment's T3 Work project");

        const firstThreadIds = first.imported.map((item) => item.threadId);
        imports.clear();
        bindings.clear();
        const reimportedAfterReset = yield* service.importSessions(input);
        expect(reimportedAfterReset.imported.map((item) => item.threadId)).not.toEqual(
          firstThreadIds,
        );
      }),
  );

  effectIt.effect("resets every scope-owned shell in the canonical project", () =>
    Effect.gen(function* () {
      const deleted: string[] = [];
      let cleared = false;
      const repository = {
        // Already scoped to provider instance + profile + project by SQL.
        listHistoryThreadIds: () =>
          Effect.succeed(["thread:owned", "thread:other-project", "thread:switched-provider"]),
        clearHistoryRecords: (scope: unknown) =>
          Effect.sync(() => {
            expect(scope).toEqual({
              providerInstanceId: "hermes-custom",
              profileKey: "profile-a",
              projectId: "project:work",
            });
            cleared = true;
            return 3;
          }),
      } as unknown as HermesSessionBindingRepository["Service"];
      const registry = ProviderInstanceRegistry.of({
        getInstance: () =>
          Effect.succeed({
            driverKind: ProviderDriverKind.make("hermes"),
            hermesSessionCatalog: {
              profileKey: "profile-a",
              importEnabled: false,
            },
          } as ProviderInstance),
        listInstances: Effect.succeed([
          {
            instanceId: ProviderInstanceId.make("hermes-custom"),
            driverKind: ProviderDriverKind.make("hermes"),
          } as never,
        ]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      });
      const threadManagement = {
        getShellSnapshot: () =>
          Effect.succeed({
            schemaVersion: 1,
            snapshotSequence: 1,
            threads: [
              {
                id: ThreadId.make("thread:work:1"),
                projectId: ProjectId.make("project:work"),
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
              {
                id: ThreadId.make("thread:owned"),
                projectId: ProjectId.make("project:work"),
                providerInstanceId: ProviderInstanceId.make("hermes-custom"),
              },
              {
                id: ThreadId.make("thread:other-project"),
                projectId: ProjectId.make("project:other"),
                providerInstanceId: ProviderInstanceId.make("hermes-custom"),
              },
              // Imported under this scope, then moved by provider.switch: it is
              // still scope-owned history and must be deleted, not orphaned.
              {
                id: ThreadId.make("thread:switched-provider"),
                projectId: ProjectId.make("project:work"),
                providerInstanceId: ProviderInstanceId.make("hermes-other"),
              },
              {
                id: ThreadId.make("thread:non-hermes"),
                projectId: ProjectId.make("project:work"),
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
            ],
            archivedThreads: [
              {
                id: ThreadId.make("thread:work:2"),
                projectId: ProjectId.make("project:work"),
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
            ],
          } as never),
        dispatch: (command: OrchestrationV2Command) =>
          Effect.sync(() => {
            if (command.type === "thread.delete") deleted.push(command.threadId);
            return {} as never;
          }),
      } as unknown as ThreadManagementService["Service"];
      const service = yield* make.pipe(
        Effect.provideService(ProviderInstanceRegistry, registry),
        Effect.provideService(HermesSessionBindingRepository, repository),
        Effect.provideService(ThreadManagementService, threadManagement),
        Effect.provideService(ProjectService, testProjectService(ProjectId.make("project:work"))),
        Effect.provideService(ServerConfig, testServerConfig),
      );

      const result = yield* service.resetHistory({
        providerInstanceId: ProviderInstanceId.make("hermes-custom"),
        backingProjectId: ProjectId.make("project:work"),
        operationId: "reset:test",
      });

      expect(deleted).toEqual(["thread:owned", "thread:switched-provider"]);
      expect(cleared).toBe(true);
      expect(result).toEqual({ deletedThreadCount: 2, clearedImportCount: 3 });
    }),
  );

  effectIt.effect("creates the main T3 Work thread when no sessions match the age cutoff", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("hermes-work-empty");
      yield* advanceToTestNow;
      const imports = new Map<string, HermesSessionImport>();
      const commands: OrchestrationV2Command[] = [];
      const repository = {
        getMainSessionImport: () =>
          Effect.succeed(
            Option.fromUndefinedOr([...imports.values()].find((row) => row.importKind === "main")),
          ),
        prepareSessionImport: (input: {
          readonly importId: string;
          readonly providerInstanceId: string;
          readonly profileKey: string;
          readonly projectId: string;
          readonly importKind: "session" | "main";
          readonly storedSessionKey: string | null;
          readonly threadId: string;
          readonly now: string;
        }) =>
          Effect.sync(() => {
            const row: HermesSessionImport = {
              ...input,
              inheritedMessageCount: null,
              state: "prepared",
              createdAt: input.now,
              updatedAt: input.now,
            };
            imports.set(row.importId, row);
            return row;
          }),
        transitionSessionImport: (input: {
          readonly importId: string;
          readonly to: "thread_created" | "completed";
          readonly now: string;
        }) =>
          Effect.sync(() => {
            const row = imports.get(input.importId);
            if (!row) return false;
            imports.set(input.importId, { ...row, state: input.to, updatedAt: input.now });
            return true;
          }),
      } as unknown as HermesSessionBindingRepository["Service"];
      const registry = ProviderInstanceRegistry.of({
        getInstance: () =>
          Effect.succeed({
            driverKind: ProviderDriverKind.make("hermes"),
            hermesSessionCatalog: {
              profileKey: "empty-profile",
              importEnabled: true,
              list: () =>
                Effect.succeed({
                  providerInstanceId,
                  profileKey: "empty-profile",
                  compatibility: {
                    status: "supported",
                    protocol: { major: 1, minor: 0 },
                    capabilities: ["session.lifecycle", "session.history"],
                    inventory: ["session.lifecycle", "session.history"],
                    reason: "test negotiation",
                  },
                  sessions: [
                    {
                      id: "old-discord",
                      title: "Too old",
                      preview: "",
                      started_at: TEST_NOW_SECONDS - 2 * 24 * 60 * 60,
                      message_count: 1,
                      source: "discord",
                    },
                  ],
                }),
            },
          } as never),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      });
      const threadManagement = {
        dispatch: (command: OrchestrationV2Command) =>
          Effect.sync(() => {
            commands.push(command);
            return {} as never;
          }),
      } as unknown as ThreadManagementService["Service"];

      const service = yield* make.pipe(
        Effect.provideService(ProviderInstanceRegistry, registry),
        Effect.provideService(HermesSessionBindingRepository, repository),
        Effect.provideService(ThreadManagementService, threadManagement),
        Effect.provideService(
          ProjectService,
          testProjectService(ProjectId.make("internal-work-backing")),
        ),
        Effect.provideService(ServerConfig, testServerConfig),
      );
      const result = yield* service.importSessions({
        providerInstanceId,
        backingProjectId: ProjectId.make("internal-work-backing"),
        selection: { type: "all" },
        activeWithinDays: 1,
      });

      expect(result.imported).toEqual([]);
      expect(result.mainThreadId).not.toBeNull();
      expect(commands.filter((command) => command.type === "thread.create")).toHaveLength(1);
    }),
  );

  effectIt.effect(
    "propagates upstream started_at into imported thread timestamps and hydrates at import time",
    () =>
      Effect.gen(function* () {
        const providerInstanceId = ProviderInstanceId.make("hermes-work-timestamps");
        const profileKey = "private-work";
        yield* advanceToTestNow;
        const startedAtSeconds = TEST_NOW_SECONDS - 3600;
        const imports = new Map<string, HermesSessionImport>();
        const boundThreadIds = new Set<string>();
        const bindingNows: string[] = [];
        const commands: OrchestrationV2Command[] = [];
        const hydrated: ThreadId[] = [];

        const repository = {
          getSessionImportByStoredIdentity: () => Effect.succeed(Option.none()),
          prepareSessionImport: (input: {
            readonly importId: string;
            readonly providerInstanceId: string;
            readonly profileKey: string;
            readonly projectId: string;
            readonly importKind: "session" | "main";
            readonly storedSessionKey: string | null;
            readonly threadId: string;
            readonly now: string;
          }) =>
            Effect.sync(() => {
              const row: HermesSessionImport = {
                importId: input.importId,
                providerInstanceId: input.providerInstanceId,
                profileKey: input.profileKey,
                projectId: input.projectId,
                importKind: input.importKind,
                storedSessionKey: input.storedSessionKey,
                threadId: input.threadId,
                inheritedMessageCount: null,
                state: "prepared",
                createdAt: input.now,
                updatedAt: input.now,
              };
              imports.set(row.importId, row);
              return row;
            }),
          transitionSessionImport: () => Effect.succeed(true),
          getMainSessionImport: () => Effect.succeed(Option.none()),
          getByStoredIdentity: () => Effect.succeed(Option.none()),
          getByThreadId: (threadId: string) =>
            Effect.succeed(
              boundThreadIds.has(threadId)
                ? Option.some({
                    providerInstanceId: String(providerInstanceId),
                  })
                : Option.none(),
            ),
          createBinding: (input: { readonly threadId: string; readonly now: string }) =>
            Effect.sync(() => {
              boundThreadIds.add(input.threadId);
              bindingNows.push(input.now);
              return true;
            }),
        } as unknown as HermesSessionBindingRepository["Service"];
        const registry = ProviderInstanceRegistry.of({
          getInstance: () =>
            Effect.succeed({
              driverKind: ProviderDriverKind.make("hermes"),
              hermesSessionCatalog: {
                profileKey,
                importEnabled: true,
                list: () =>
                  Effect.succeed({
                    providerInstanceId,
                    profileKey,
                    compatibility: {
                      status: "supported",
                      protocol: { major: 1, minor: 0 },
                      capabilities: ["session.lifecycle", "session.history"],
                      inventory: ["session.lifecycle", "session.history"],
                      reason: "test negotiation",
                    },
                    sessions: [
                      {
                        id: "discord-hour-old",
                        title: "Hour-old Discord",
                        preview: "",
                        started_at: startedAtSeconds,
                        message_count: 2,
                        source: "discord",
                      },
                    ],
                  }),
              },
            } as never),
          listInstances: Effect.succeed([]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.never,
        });
        const threadManagement = {
          dispatch: (command: OrchestrationV2Command) =>
            Effect.sync(() => {
              commands.push(command);
              return {} as never;
            }),
        } as unknown as ThreadManagementService["Service"];
        const orchestrator = {
          hydrateProviderThreadSnapshot: (input: { readonly threadId: ThreadId }) =>
            Effect.sync(() => {
              hydrated.push(input.threadId);
            }),
        } as unknown as OrchestratorV2["Service"];

        const service = yield* make.pipe(
          Effect.provideService(ProviderInstanceRegistry, registry),
          Effect.provideService(HermesSessionBindingRepository, repository),
          Effect.provideService(ThreadManagementService, threadManagement),
          Effect.provideService(OrchestratorV2, orchestrator),
          Effect.provideService(
            ProjectService,
            testProjectService(ProjectId.make("internal-work-backing")),
          ),
          Effect.provideService(ServerConfig, testServerConfig),
        );

        const result = yield* service.importSessions({
          providerInstanceId,
          backingProjectId: ProjectId.make("internal-work-backing"),
          selection: { type: "all" },
          activeWithinDays: 7,
          ensureMain: false,
        });

        const expectedStartedAt = DateTime.makeUnsafe(startedAtSeconds * 1_000);
        const creates = commands.filter(
          (command): command is Extract<OrchestrationV2Command, { type: "thread.create" }> =>
            command.type === "thread.create",
        );
        expect(creates).toHaveLength(1);
        expect(creates[0]!.createdAt).toEqual(expectedStartedAt);
        expect(bindingNows).toEqual([DateTime.formatIso(expectedStartedAt)]);
        expect(hydrated).toEqual(result.imported.map((item) => item.threadId));
        expect(hydrated).toHaveLength(1);
      }),
  );

  effectIt.effect(
    "hydrates an already-completed imported thread whenever its durable binding is opened",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread:hermes:already-imported");
        const hydrated: ThreadId[] = [];
        const repository = {
          getByThreadId: () =>
            Effect.succeed(
              Option.some({
                bindingId: "existing-binding",
                providerInstanceId: "hermes-work",
              }),
            ),
        } as unknown as HermesSessionBindingRepository["Service"];
        const registry = ProviderInstanceRegistry.of({
          getInstance: () => Effect.sync(() => undefined as never),
          listInstances: Effect.succeed([]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.never,
        });
        const threadManagement = {
          dispatch: () => Effect.die("unused dispatch"),
        } as unknown as ThreadManagementService["Service"];
        const orchestrator = {
          hydrateProviderThreadSnapshot: (input: { readonly threadId: ThreadId }) =>
            Effect.sync(() => {
              hydrated.push(input.threadId);
            }),
        } as unknown as OrchestratorV2["Service"];

        const service = yield* make.pipe(
          Effect.provideService(ProviderInstanceRegistry, registry),
          Effect.provideService(HermesSessionBindingRepository, repository),
          Effect.provideService(ThreadManagementService, threadManagement),
          Effect.provideService(OrchestratorV2, orchestrator),
          Effect.provideService(
            ProjectService,
            testProjectService(ProjectId.make("internal-work-backing")),
          ),
          Effect.provideService(ServerConfig, testServerConfig),
        );
        yield* service.hydrateThread(threadId);
        yield* service.hydrateThread(threadId);

        expect(hydrated).toEqual([threadId, threadId]);
      }),
  );

  effectIt.effect("omits historical timestamps when upstream started_at is not a valid epoch", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("hermes-work-invalid-epoch");
      const profileKey = "private-work";
      yield* advanceToTestNow;
      const imports = new Map<string, HermesSessionImport>();
      const bindingNows: string[] = [];
      const commands: OrchestrationV2Command[] = [];

      const repository = {
        prepareSessionImport: (input: {
          readonly importId: string;
          readonly providerInstanceId: string;
          readonly profileKey: string;
          readonly projectId: string;
          readonly importKind: "session" | "main";
          readonly storedSessionKey: string | null;
          readonly threadId: string;
          readonly now: string;
        }) =>
          Effect.sync(() => {
            const row: HermesSessionImport = {
              ...input,
              inheritedMessageCount: null,
              state: "prepared",
              createdAt: input.now,
              updatedAt: input.now,
            };
            imports.set(row.importId, row);
            return row;
          }),
        transitionSessionImport: () => Effect.succeed(true),
        getMainSessionImport: () => Effect.succeed(Option.none()),
        getByStoredIdentity: () => Effect.succeed(Option.none()),
        getByThreadId: () => Effect.succeed(Option.none()),
        createBinding: (input: { readonly now: string }) =>
          Effect.sync(() => {
            bindingNows.push(input.now);
            return true;
          }),
      } as unknown as HermesSessionBindingRepository["Service"];
      const registry = ProviderInstanceRegistry.of({
        getInstance: () =>
          Effect.succeed({
            driverKind: ProviderDriverKind.make("hermes"),
            hermesSessionCatalog: {
              profileKey,
              importEnabled: true,
              list: () =>
                Effect.succeed({
                  providerInstanceId,
                  profileKey,
                  compatibility: {
                    status: "supported",
                    protocol: { major: 1, minor: 0 },
                    capabilities: ["session.lifecycle", "session.history"],
                    inventory: ["session.lifecycle", "session.history"],
                    reason: "test negotiation",
                  },
                  sessions: [
                    {
                      id: "discord-zero-epoch",
                      title: "Missing timestamp",
                      preview: "",
                      started_at: 0,
                      message_count: 1,
                      source: "discord",
                    },
                    {
                      id: "discord-negative-epoch",
                      title: "Negative timestamp",
                      preview: "",
                      started_at: -3_600,
                      message_count: 1,
                      source: "discord",
                    },
                  ],
                }),
            },
          } as never),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      });
      const threadManagement = {
        dispatch: (command: OrchestrationV2Command) =>
          Effect.sync(() => {
            commands.push(command);
            return {} as never;
          }),
      } as unknown as ThreadManagementService["Service"];

      const service = yield* make.pipe(
        Effect.provideService(ProviderInstanceRegistry, registry),
        Effect.provideService(HermesSessionBindingRepository, repository),
        Effect.provideService(ThreadManagementService, threadManagement),
        Effect.provideService(
          ProjectService,
          testProjectService(ProjectId.make("internal-work-backing")),
        ),
        Effect.provideService(ServerConfig, testServerConfig),
      );
      // A huge window keeps both non-positive epochs eligible for import.
      const result = yield* service.importSessions({
        providerInstanceId,
        backingProjectId: ProjectId.make("internal-work-backing"),
        selection: { type: "all" },
        activeWithinDays: 100_000,
        ensureMain: false,
      });

      expect(result.imported.map((item) => item.storedSessionId)).toEqual([
        "discord-zero-epoch",
        "discord-negative-epoch",
      ]);
      const creates = commands.filter(
        (command): command is Extract<OrchestrationV2Command, { type: "thread.create" }> =>
          command.type === "thread.create",
      );
      expect(creates).toHaveLength(2);
      expect(creates.every((command) => command.createdAt === undefined)).toBe(true);
      const settles = commands.filter(
        (command): command is Extract<OrchestrationV2Command, { type: "thread.settle" }> =>
          command.type === "thread.settle",
      );
      expect(settles).toHaveLength(2);
      expect(settles.every((command) => command.settledAt === undefined)).toBe(true);
      // Bindings fall back to wall-clock time rather than a 1970 epoch.
      expect(bindingNows).toEqual([
        DateTime.formatIso(DateTime.makeUnsafe(TEST_NOW_MILLIS)),
        DateTime.formatIso(DateTime.makeUnsafe(TEST_NOW_MILLIS)),
      ]);
    }),
  );

  effectIt.effect("separates unknown selected sessions from filtered-out ones", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("hermes-work-selection");
      const profileKey = "private-work";
      yield* advanceToTestNow;
      const registry = ProviderInstanceRegistry.of({
        getInstance: () =>
          Effect.succeed({
            driverKind: ProviderDriverKind.make("hermes"),
            hermesSessionCatalog: {
              profileKey,
              importEnabled: true,
              list: () =>
                Effect.succeed({
                  providerInstanceId,
                  profileKey,
                  compatibility: {
                    status: "supported",
                    protocol: { major: 1, minor: 0 },
                    capabilities: ["session.lifecycle", "session.history"],
                    inventory: ["session.lifecycle", "session.history"],
                    reason: "test negotiation",
                  },
                  sessions: [
                    {
                      id: "discord-too-old",
                      title: "Too old",
                      preview: "",
                      started_at: TEST_NOW_SECONDS - 30 * 24 * 60 * 60,
                      message_count: 1,
                      source: "discord",
                    },
                  ],
                }),
            },
          } as never),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      });
      const service = yield* make.pipe(
        Effect.provideService(ProviderInstanceRegistry, registry),
        Effect.provideService(HermesSessionBindingRepository, {} as never),
        Effect.provideService(ThreadManagementService, {} as never),
        Effect.provideService(
          ProjectService,
          testProjectService(ProjectId.make("internal-work-backing")),
        ),
        Effect.provideService(ServerConfig, testServerConfig),
      );
      const base = {
        providerInstanceId,
        backingProjectId: ProjectId.make("internal-work-backing"),
        activeWithinDays: 1,
      } as const;

      const filteredOut = yield* Effect.flip(
        service.importSessions({
          ...base,
          selection: { type: "selected", sessionIds: ["discord-too-old"] },
        }),
      );
      const neverReturned = yield* Effect.flip(
        service.importSessions({
          ...base,
          selection: { type: "selected", sessionIds: ["discord-unknown"] },
        }),
      );

      expect(filteredOut.message).toContain("activity window");
      expect(neverReturned.message).toContain("not returned by the configured profile");
    }),
  );

  effectIt.effect("resolves imported thread ids with a single scoped import query", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("hermes-work-discover");
      const profileKey = "private-work";
      yield* advanceToTestNow;
      let listCalls = 0;
      const repository = {
        listSessionImports: () =>
          Effect.sync(() => {
            listCalls += 1;
            return [
              {
                importId: "hermes-import:session:a",
                providerInstanceId: String(providerInstanceId),
                profileKey,
                projectId: "internal-work-backing",
                importKind: "session",
                storedSessionKey: "discord-a",
                threadId: "thread:hermes:session:a",
                inheritedMessageCount: null,
                state: "completed",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              } satisfies HermesSessionImport,
            ];
          }),
        getSessionImportByStoredIdentity: () => Effect.die("discovery must not query per session"),
        getMainSessionImport: () => Effect.succeed(Option.none()),
      } as unknown as HermesSessionBindingRepository["Service"];
      const registry = ProviderInstanceRegistry.of({
        getInstance: () =>
          Effect.succeed({
            driverKind: ProviderDriverKind.make("hermes"),
            hermesSessionCatalog: {
              profileKey,
              importEnabled: true,
              list: () =>
                Effect.succeed({
                  providerInstanceId,
                  profileKey,
                  compatibility: {
                    status: "supported",
                    protocol: { major: 1, minor: 0 },
                    capabilities: ["session.lifecycle", "session.history"],
                    inventory: ["session.lifecycle", "session.history"],
                    reason: "test negotiation",
                  },
                  sessions: [
                    {
                      id: "discord-a",
                      title: "Imported",
                      preview: "",
                      started_at: TEST_NOW_SECONDS - 60,
                      message_count: 2,
                      source: "discord",
                    },
                    {
                      id: "discord-b",
                      title: "Not imported",
                      preview: "",
                      started_at: TEST_NOW_SECONDS - 60,
                      message_count: 2,
                      source: "discord",
                    },
                    {
                      id: "tui-c",
                      title: "Local",
                      preview: "",
                      started_at: TEST_NOW_SECONDS - 60,
                      message_count: 2,
                      source: "tui",
                    },
                  ],
                }),
            },
          } as never),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      });
      const service = yield* make.pipe(
        Effect.provideService(ProviderInstanceRegistry, registry),
        Effect.provideService(HermesSessionBindingRepository, repository),
        Effect.provideService(ThreadManagementService, {} as never),
        Effect.provideService(
          ProjectService,
          testProjectService(ProjectId.make("internal-work-backing")),
        ),
        Effect.provideService(ServerConfig, testServerConfig),
      );

      const result = yield* service.discover({ providerInstanceId });

      expect(listCalls).toBe(1);
      expect(
        result.sessions.map((session) => [session.storedSessionId, session.importedThreadId]),
      ).toEqual([
        ["discord-a", ThreadId.make("thread:hermes:session:a")],
        ["discord-b", null],
      ]);
    }),
  );
});
