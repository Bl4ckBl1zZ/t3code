import { CommandId, EventId, ProjectId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";

const BaseTestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-projection-bootstrap-test-" }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("replays a bootstrap backlog larger than the event store default limit", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const projectId = ProjectId.make("project-bootstrap-backlog");

      const sequenceRows = yield* sql<{ readonly maxSequence: number | null }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const sequenceBeforeBacklog = sequenceRows[0]?.maxSequence ?? 0;
      const appendedEvents = yield* Effect.forEach(
        Array.from({ length: 1_001 }, (_, index) => index),
        (index) => {
          const eventId = EventId.make(`evt-bootstrap-backlog-${index}`);
          const commandId = CommandId.make(`cmd-bootstrap-backlog-${index}`);
          return eventStore.append({
            type: "project.created",
            eventId,
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: now,
            commandId,
            causationEventId: null,
            correlationId: commandId,
            metadata: {},
            payload: {
              projectId,
              title: `Bootstrap backlog ${index}`,
              workspaceRoot: "/tmp/project-bootstrap-backlog",
              defaultModelSelection: null,
              scripts: [],
              createdAt: now,
              updatedAt: now,
            },
          });
        },
      );
      const lastSequence = appendedEvents[appendedEvents.length - 1]!.sequence;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES (${ORCHESTRATION_PROJECTOR_NAMES.projects}, ${sequenceBeforeBacklog}, ${now})
        ON CONFLICT (projector)
        DO UPDATE SET
          last_applied_sequence = excluded.last_applied_sequence,
          updated_at = excluded.updated_at
      `;

      yield* projectionPipeline.bootstrap;

      const stateRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.projects}
      `;
      assert.deepEqual(stateRows, [{ lastAppliedSequence: lastSequence }]);
    }),
  );
});
