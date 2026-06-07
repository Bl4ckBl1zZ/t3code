import {
  CommandId,
  DEFAULT_LOCAL_ORGANIZATION_ID,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  WorkspaceActionId,
  WorkspaceId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asWorkspaceId = (value: string): WorkspaceId => WorkspaceId.make(value);
const asWorkspaceActionId = (value: string): WorkspaceActionId => WorkspaceActionId.make(value);

const seedReadModel = Effect.gen(function* () {
  const now = "2026-01-01T00:00:00.000Z";
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-delete"),
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-delete"),
      title: "Project Delete",
      workspaceRoot: "/tmp/project-delete",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });

  const withWorkspace = yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-workspace-create"),
    aggregateKind: "workspace",
    aggregateId: asWorkspaceId("project-delete:primary"),
    type: "workspace.created",
    occurredAt: now,
    commandId: asCommandId("cmd-workspace-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-workspace-create"),
    metadata: {},
    payload: {
      workspaceId: asWorkspaceId("project-delete:primary"),
      organizationId: DEFAULT_LOCAL_ORGANIZATION_ID,
      projectId: asProjectId("project-delete"),
      title: "main",
      cwd: "/tmp/project-delete",
      branch: null,
      worktreePath: null,
      baseBranch: null,
      mode: "local",
      status: "ready",
      defaultSubChatId: null,
      browserPreviewUrl: null,
      createdAt: now,
      updatedAt: now,
    },
  });

  const withFirstThread = yield* projectEvent(withWorkspace, {
    sequence: 3,
    eventId: asEventId("evt-thread-create-1"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-1"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-1"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-1"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-1"),
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 1",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });

  return yield* projectEvent(withFirstThread, {
    sequence: 4,
    eventId: asEventId("evt-thread-create-2"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-2"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-2"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-2"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-2"),
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 2",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

const seedReadModelWithActiveThread = Effect.gen(function* () {
  const readModel = yield* seedReadModel;
  const now = "2026-01-01T00:00:01.000Z";
  return yield* projectEvent(readModel, {
    sequence: readModel.snapshotSequence + 1,
    eventId: asEventId("evt-thread-session-running"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-1"),
    type: "thread.session-set",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-session-running"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-session-running"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-1"),
      session: {
        threadId: asThreadId("thread-delete-1"),
        status: "running",
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "approval-required",
        activeTurnId: asTurnId("turn-active"),
        lastError: null,
        updatedAt: now,
      },
    },
  });
});

const seedReadModelWithActiveWorkspaceAction = Effect.gen(function* () {
  const readModel = yield* seedReadModel;
  const now = "2026-01-01T00:00:01.000Z";
  return yield* projectEvent(readModel, {
    sequence: readModel.snapshotSequence + 1,
    eventId: asEventId("evt-workspace-action-running"),
    aggregateKind: "workspace-action",
    aggregateId: asWorkspaceActionId("action-running"),
    type: "workspace-action.upserted",
    occurredAt: now,
    commandId: asCommandId("cmd-workspace-action-running"),
    causationEventId: null,
    correlationId: asCommandId("cmd-workspace-action-running"),
    metadata: {},
    payload: {
      action: {
        id: asWorkspaceActionId("action-running"),
        organizationId: DEFAULT_LOCAL_ORGANIZATION_ID,
        projectId: asProjectId("project-delete"),
        workspaceId: asWorkspaceId("project-delete:primary"),
        subChatId: asThreadId("thread-delete-1"),
        terminalId: null,
        kind: "script.run",
        title: "Run tests",
        status: "running",
        source: "script",
        createdAt: now,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    },
  });
});

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

function normalizeDeleteEvent(event: PlannedEvent | ReadonlyArray<PlannedEvent>) {
  const events = Array.isArray(event) ? event : [event];
  return events.map((entry) => {
    switch (entry.type) {
      case "thread.deleted":
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            threadId: entry.payload.threadId,
          },
        };
      case "project.deleted":
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            projectId: entry.payload.projectId,
          },
        };
      default:
        return entry;
    }
  });
}

it.layer(NodeServices.layer)("decider deletion flows", (it) => {
  it.effect("rejects deleting a non-empty project without force", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-project-delete-no-force"),
            projectId: asProjectId("project-delete"),
          },
          readModel,
        }),
      );
      expect(error.message).toContain("cannot be deleted without force=true");
    }),
  );

  it.effect("reuses thread.delete semantics when force-deleting a non-empty project", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const projectDeleteCommand: Extract<OrchestrationCommand, { type: "project.delete" }> = {
        type: "project.delete",
        commandId: asCommandId("cmd-project-delete-force"),
        projectId: asProjectId("project-delete"),
        force: true,
      };

      const forcedResult = yield* decideOrchestrationCommand({
        command: projectDeleteCommand,
        readModel,
      });
      const forcedEvents = Array.isArray(forcedResult) ? forcedResult : [forcedResult];

      expect(forcedEvents.map((event) => event.type)).toEqual([
        "thread.deleted",
        "thread.deleted",
        "project.deleted",
      ]);

      let sequentialReadModel = readModel;
      let nextSequence = readModel.snapshotSequence;
      const sequentialEvents: PlannedEvent[] = [];
      for (const nextCommand of [
        {
          type: "thread.delete",
          commandId: projectDeleteCommand.commandId,
          threadId: asThreadId("thread-delete-1"),
        },
        {
          type: "thread.delete",
          commandId: projectDeleteCommand.commandId,
          threadId: asThreadId("thread-delete-2"),
        },
        {
          type: "project.delete",
          commandId: projectDeleteCommand.commandId,
          projectId: asProjectId("project-delete"),
        },
      ] satisfies ReadonlyArray<OrchestrationCommand>) {
        const decided = yield* decideOrchestrationCommand({
          command: nextCommand,
          readModel: sequentialReadModel,
        });
        const nextEvents = Array.isArray(decided) ? decided : [decided];
        sequentialEvents.push(...nextEvents);
        for (const nextEvent of nextEvents) {
          nextSequence += 1;
          sequentialReadModel = yield* projectEvent(sequentialReadModel, {
            ...nextEvent,
            sequence: nextSequence,
          });
        }
      }

      expect(normalizeDeleteEvent(forcedResult)).toEqual(normalizeDeleteEvent(sequentialEvents));
    }),
  );

  it.effect("rejects deleting a thread with an active session", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModelWithActiveThread;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.delete",
            commandId: asCommandId("cmd-thread-delete-active"),
            threadId: asThreadId("thread-delete-1"),
          },
          readModel,
        }),
      );

      expect(error.message).toContain("has an active session");
    }),
  );

  it.effect("rejects force-deleting a project while any child thread has an active session", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModelWithActiveThread;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-project-delete-force-active"),
            projectId: asProjectId("project-delete"),
            force: true,
          },
          readModel,
        }),
      );

      expect(error.message).toContain("has an active session");
    }),
  );

  it.effect("rejects deleting a workspace with an active sub-chat session", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModelWithActiveThread;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "workspace.delete",
            commandId: asCommandId("cmd-workspace-delete-active-thread"),
            workspaceId: asWorkspaceId("project-delete:primary"),
          },
          readModel,
        }),
      );

      expect(error.message).toContain("has active sub-chat");
    }),
  );

  it.effect("rejects archiving a workspace with an active action", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModelWithActiveWorkspaceAction;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "workspace.archive",
            commandId: asCommandId("cmd-workspace-archive-active-action"),
            workspaceId: asWorkspaceId("project-delete:primary"),
          },
          readModel,
        }),
      );

      expect(error.message).toContain("has active action");
    }),
  );
});
