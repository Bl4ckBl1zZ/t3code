/**
 * ProjectionSnapshotQuery - Project read-model query service interface.
 *
 * Exposes the project half of the application read model. Thread reads live in
 * the orchestration V2 projection store; this service only serves the project
 * aggregate that V2 shells are grouped under.
 *
 * @module ProjectionSnapshotQuery
 */
import type { OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import type { OrchestrationReadModel } from "@t3tools/contracts/legacy-orchestration";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

/**
 * ProjectionSnapshotQueryShape - Service API for project read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the decider's project read model, including soft-deleted projects.
   *
   * The orchestration engine hydrates its in-memory command read model from
   * this query on startup so command invariants see committed state.
   */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read every active project shell with null repository metadata.
   *
   * Transactional callers use this method and enrich the returned projects
   * only after their transaction has closed.
   */
  readonly getProjectShellsWithoutEnrichment: () => Effect.Effect<
    ReadonlyArray<OrchestrationProjectShell>,
    ProjectionRepositoryError
  >;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
