import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type ApplicationStoredEvent, CommandId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const enrichmentLayer = ProjectEnrichmentService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
);

/**
 * One server's project engine over the database at `dbPath`, recording every
 * event it publishes to subscribers.
 */
const makeServer = (dbPath: string) => {
  const published: Array<ApplicationStoredEvent> = [];
  const eventStore = Layer.effect(
    OrchestrationEventStore,
    Effect.gen(function* () {
      const real = yield* OrchestrationEventStore;
      return {
        ...real,
        publishCommitted: (events: ReadonlyArray<ApplicationStoredEvent>) =>
          Effect.sync(() => published.push(...events)).pipe(
            Effect.andThen(real.publishCommitted(events)),
          ),
      };
    }),
  ).pipe(Layer.provide(OrchestrationEventStoreLive));
  const layer = OrchestrationEngineLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        OrchestrationProjectionSnapshotQueryLive,
        eventStore,
        OrchestrationCommandReceiptRepositoryLive,
        OrchestrationProjectionPipelineLive.pipe(Layer.provide(eventStore)),
      ),
    ),
    Layer.provide(enrichmentLayer),
    Layer.provide(makeSqlitePersistenceLive(dbPath)),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-engine-test-" })),
    Layer.provide(NodeServices.layer),
  );
  return { layer, published };
};

it.effect("does not republish another server's events when a local dispatch fails", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-shared-db-" });
    const dbPath = path.join(directory, "state.sqlite");
    const serverA = makeServer(dbPath);
    const serverB = makeServer(dbPath);
    const engineA = yield* Layer.build(serverA.layer);
    const engineB = yield* Layer.build(serverB.layer);
    const projectId = ProjectId.make("project-shared");
    const sentinelCommandId = CommandId.make("cmd-shared-rename");

    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-shared-project-create"),
        projectId,
        title: "Shared Project",
        workspaceRoot: "/tmp/project-shared",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-03T00:00:00.000Z",
      });
    }).pipe(Effect.provide(engineA));

    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      // B's command model predates A's project, so this fails and reconciles.
      yield* engine
        .dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("cmd-shared-stale-rename"),
          projectId,
          title: "stale",
        })
        .pipe(Effect.flip);
      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: sentinelCommandId,
        projectId,
        title: "renamed on B",
      });
    }).pipe(Effect.provide(engineB));

    assert.deepEqual(
      serverB.published.map((event) => ("type" in event ? [event.type, event.commandId] : null)),
      [["project.meta-updated", sentinelCommandId]],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
