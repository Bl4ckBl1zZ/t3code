import { CommandId, EventId, ProjectId, type ProjectScript } from "@t3tools/contracts";
import type { OrchestrationEvent } from "@t3tools/contracts/legacy-orchestration";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

it.layer(NodeServices.layer)("decider project scripts", (it) => {
  const script = (id: string): ProjectScript => ({
    id,
    name: "Install dependencies",
    command: "vp i",
    icon: "configure",
    runOnWorktreeCreate: false,
  });

  const projectWithScripts = (scripts: ReadonlyArray<ProjectScript>) => {
    const now = "2026-01-01T00:00:00.000Z";
    return projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: EventId.make("evt-legacy-scripts"),
      aggregateKind: "project",
      aggregateId: ProjectId.make("project-scripts"),
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.make("cmd-legacy-scripts"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-legacy-scripts"),
      metadata: {},
      payload: {
        projectId: ProjectId.make("project-scripts"),
        title: "Scripts",
        workspaceRoot: "/tmp/scripts",
        defaultModelSelection: null,
        scripts,
        createdAt: now,
        updatedAt: now,
      },
    });
  };

  for (const id of ["install-javascript-dependencies", "A", "a.b", "a b", "-a", "a".repeat(25)]) {
    it.effect(`rejects a new script ID that cannot have a shortcut: ${id}`, () =>
      Effect.gen(function* () {
        const readModel = yield* projectWithScripts([]);
        const failure = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel,
            command: {
              type: "project.meta.update",
              commandId: CommandId.make("cmd-invalid-script"),
              projectId: ProjectId.make("project-scripts"),
              scripts: [script("lint"), script(id)],
            },
          }),
        );
        expect(failure).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
        expect(failure.message).toContain("Script ID");
        expect(failure.message).toContain("24");
        expect(readModel.projects[0]?.scripts).toEqual([]);
      }),
    );
  }

  it.effect("accepts a script ID at the shortcut length limit", () =>
    Effect.gen(function* () {
      const readModel = yield* projectWithScripts([]);
      const scripts = [script("a".repeat(24))];
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-valid-script"),
          projectId: ProjectId.make("project-scripts"),
          scripts,
        },
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.payload).toMatchObject({ scripts });
    }),
  );

  it.effect(
    "keeps legacy scripts readable, editable and removable while allowing valid additions",
    () =>
      Effect.gen(function* () {
        const legacy = script("install-javascript-dependencies");
        const readModel = yield* projectWithScripts([legacy]);
        expect(readModel.projects[0]?.scripts).toEqual([legacy]);
        for (const scripts of [[{ ...legacy, command: "vp install" }, script("lint")], []]) {
          const result = yield* decideOrchestrationCommand({
            readModel,
            command: {
              type: "project.meta.update",
              commandId: CommandId.make("cmd-repair-script"),
              projectId: ProjectId.make("project-scripts"),
              scripts,
            },
          });
          const event = Array.isArray(result) ? result[0] : result;
          expect(event.payload).toMatchObject({ scripts });
        }
        const failure = yield* Effect.flip(
          decideOrchestrationCommand({
            readModel,
            command: {
              type: "project.meta.update",
              commandId: CommandId.make("cmd-new-invalid-script"),
              projectId: ProjectId.make("project-scripts"),
              scripts: [legacy, script("another.invalid.id")],
            },
          }),
        );
        expect(failure).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      }),
  );
});
