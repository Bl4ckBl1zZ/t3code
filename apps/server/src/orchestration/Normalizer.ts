import * as Effect from "effect/Effect";
import {
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import { makeProjectConfigResolverFunction } from "../project/Layers/ProjectConfigResolver.ts";
import { persistUploadChatAttachments } from "../uploadChatAttachments.ts";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths;
    const resolveProjectConfig = yield* makeProjectConfigResolverFunction;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    if (command.type === "project.create") {
      const workspaceRoot = yield* normalizeProjectWorkspaceRootForCreate(
        command.workspaceRoot,
        command.createWorkspaceRootIfMissing,
      );
      const projectConfig = yield* resolveProjectConfig({ cwd: workspaceRoot });
      return {
        ...command,
        workspaceRoot,
        createWorkspaceRootIfMissing: command.createWorkspaceRootIfMissing === true,
        scripts: command.scripts ?? projectConfig.scripts,
        browserPreviewUrl: command.browserPreviewUrl ?? projectConfig.browserPreviewUrl,
      } satisfies OrchestrationCommand;
    }

    if (command.type === "project.meta.update" && command.workspaceRoot !== undefined) {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (command.type !== "thread.turn.start") {
      return command as OrchestrationCommand;
    }

    const normalizedAttachments = yield* persistUploadChatAttachments({
      attachments: command.message.attachments,
      attachmentsDir: serverConfig.attachmentsDir,
      attachmentScopeId: command.threadId,
      toError: (message) => new OrchestrationDispatchCommandError({ message }),
    });

    return {
      ...command,
      message: {
        ...command.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });
