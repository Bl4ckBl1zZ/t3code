import * as Layer from "effect/Layer";

import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { layer as projectServiceLayer } from "../project/ProjectService.ts";
import { layer as threadLaunchServiceLayer } from "./ThreadLaunchService.ts";
import { layer as threadLifecycleServiceLayer } from "./ThreadLifecycleService.ts";
import { live as resourceCleanupLive } from "./ResourceCleanupService.ts";
import { observerLive as runFinalizationObserverLive } from "./RunFinalizationService.ts";
import { layer as worktreeRegistryLayer } from "../worktree/WorktreeRegistry.ts";
import { layer as worktreeInventoryLayer } from "../worktree/WorktreeInventoryService.ts";
import { layer as worktreeOperationCoordinatorLayer } from "../worktree/WorktreeOperationCoordinator.ts";
import { layer as worktreeProvisioningLayer } from "../worktree/WorktreeProvisioningService.ts";

const projectServiceProvided = projectServiceLayer.pipe(
  Layer.provide(ProjectionProjectRepositoryLive),
);
const worktreeInventoryProvided = worktreeInventoryLayer.pipe(Layer.provide(worktreeRegistryLayer));
const worktreeProvisioningProvided = worktreeProvisioningLayer.pipe(
  Layer.provide(Layer.mergeAll(worktreeInventoryProvided, worktreeOperationCoordinatorLayer)),
);

const applicationServices = Layer.mergeAll(
  threadLaunchServiceLayer,
  threadLifecycleServiceLayer,
).pipe(
  Layer.provideMerge(projectServiceProvided),
  Layer.provideMerge(worktreeRegistryLayer),
  Layer.provideMerge(worktreeInventoryProvided),
  Layer.provideMerge(worktreeOperationCoordinatorLayer),
  Layer.provideMerge(worktreeProvisioningProvided),
);

export const OrchestrationV2ApplicationLayer = Layer.mergeAll(
  applicationServices,
  resourceCleanupLive,
  runFinalizationObserverLive,
);
