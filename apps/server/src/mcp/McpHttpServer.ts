import * as PullRequestMcpService from "./PullRequestMcpService.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import { PullRequestsToolkitHandlersLive } from "./toolkits/pullRequests/handlers.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { OrchestratorToolkitHandlersLive } from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import { WorktreeToolkitHandlersLive } from "./toolkits/worktree/handlers.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

const makeMcpAuthMiddleware = McpSessionRegistry.McpSessionRegistry.pipe(
  Effect.map(
    (registry): McpAuthMiddleware =>
      Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        const token =
          authorization?.startsWith("Bearer ") === true
            ? authorization.slice("Bearer ".length).trim()
            : "";
        const invocation = yield* registry.resolve(token, registry.audience);
        if (!invocation) {
          // Without this the only symptom of a dead credential is the agent
          // quietly losing the whole `t3-code` toolkit for the rest of its
          // session, with nothing on the server to explain why.
          yield* Effect.logWarning("rejected MCP request with an unusable credential", {
            reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
          });
          return unauthorized;
        }
        return yield* httpEffect.pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.map(normalizeMcpHttpResponse),
        );
      }),
  ),
  Effect.withSpan("McpHttpServer.makeAuthMiddleware"),
);

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

export const MAX_SNAPSHOT_TEXT_BYTES = 60_000;
const MAX_SNAPSHOT_VISIBLE_TEXT_CHARS = 8_000;
const MAX_SNAPSHOT_ELEMENT_NAME_CHARS = 200;
const MAX_SNAPSHOT_LOG_ENTRIES = 40;
const MAX_SNAPSHOT_LOG_TEXT_CHARS = 500;
const MAX_SNAPSHOT_IDENTIFIER_CHARS = 2_048;

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const utf8Length = (text: string) => Buffer.byteLength(text, "utf8");
const cutText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Shortens every string field of a log entry; other fields pass through. */
const cutEntryStrings = <A>(entry: A): A =>
  typeof entry === "object" && entry !== null
    ? (Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [
          key,
          typeof value === "string" ? cutText(value, MAX_SNAPSHOT_LOG_TEXT_CHARS) : value,
        ]),
      ) as A)
    : entry;

const hasLongString = (entry: unknown, max: number) =>
  typeof entry === "object" &&
  entry !== null &&
  Object.values(entry).some((value) => typeof value === "string" && value.length > max);

type SnapshotMetadata = {
  readonly url: string;
  readonly title: string;
  readonly visibleText: string;
  readonly interactiveElements: ReadonlyArray<{
    readonly name: string;
    readonly [key: string]: unknown;
  }>;
  readonly consoleEntries: ReadonlyArray<unknown>;
  readonly networkEntries: ReadonlyArray<unknown>;
  readonly actionTimeline: ReadonlyArray<unknown>;
  readonly [key: string]: unknown;
};

/**
 * Drops the accessibility tree, shortens page text, element names, identifiers,
 * and log strings, keeps only the newest log entries, and finally sheds
 * interactive elements until the JSON fits. Returns the text plus notes on
 * what is missing so the agent can reach for preview_evaluate.
 */
const boundSnapshotMetadata = (
  metadata: SnapshotMetadata,
): { readonly text: string; readonly omitted: ReadonlyArray<string> } => {
  const omitted: Array<string> = [];
  const { accessibilityTree, ...withoutTree } = metadata;
  if (accessibilityTree !== undefined) {
    omitted.push("accessibilityTree (use interactiveElements locators or preview_evaluate)");
  }
  const tail = <A>(entries: ReadonlyArray<A>, label: string) => {
    if (entries.length > MAX_SNAPSHOT_LOG_ENTRIES) {
      omitted.push(`${entries.length - MAX_SNAPSHOT_LOG_ENTRIES} older ${label}`);
    }
    const kept = entries.slice(-MAX_SNAPSHOT_LOG_ENTRIES);
    if (kept.some((entry) => hasLongString(entry, MAX_SNAPSHOT_LOG_TEXT_CHARS))) {
      omitted.push(`${label} text after ${MAX_SNAPSHOT_LOG_TEXT_CHARS} characters`);
    }
    return kept.map(cutEntryStrings);
  };
  if (
    metadata.url.length > MAX_SNAPSHOT_IDENTIFIER_CHARS ||
    metadata.title.length > MAX_SNAPSHOT_IDENTIFIER_CHARS
  ) {
    omitted.push(`url or title after ${MAX_SNAPSHOT_IDENTIFIER_CHARS} characters`);
  }
  if (
    metadata.interactiveElements.some(
      (element) => element.name.length > MAX_SNAPSHOT_ELEMENT_NAME_CHARS,
    )
  ) {
    omitted.push(`element names longer than ${MAX_SNAPSHOT_ELEMENT_NAME_CHARS} characters`);
  }
  if (metadata.visibleText.length > MAX_SNAPSHOT_VISIBLE_TEXT_CHARS) {
    omitted.push(
      `visibleText after ${MAX_SNAPSHOT_VISIBLE_TEXT_CHARS} characters (use preview_evaluate for more)`,
    );
  }
  const bounded = {
    ...withoutTree,
    url: cutText(metadata.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    title: cutText(metadata.title, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    visibleText: cutText(metadata.visibleText, MAX_SNAPSHOT_VISIBLE_TEXT_CHARS),
    interactiveElements: metadata.interactiveElements.map((element) => ({
      ...element,
      name: cutText(element.name, MAX_SNAPSHOT_ELEMENT_NAME_CHARS),
    })),
    consoleEntries: tail(metadata.consoleEntries, "console entries"),
    networkEntries: tail(metadata.networkEntries, "network entries"),
    actionTimeline: tail(metadata.actionTimeline, "action timeline entries"),
  };

  // Per-field caps do not sum below the ceiling: three log arrays of 40 capped
  // entries alone can pass 60 KB. Shed the least useful lists first, halving
  // one list per round, until the JSON fits. With every list empty the rest
  // is bounded by the identifier and visibleText caps, so this terminates.
  const shedOrder = [
    "actionTimeline",
    "networkEntries",
    "consoleEntries",
    "interactiveElements",
  ] as const;
  const lists: Record<(typeof shedOrder)[number], ReadonlyArray<unknown>> = {
    interactiveElements: bounded.interactiveElements,
    consoleEntries: bounded.consoleEntries,
    networkEntries: bounded.networkEntries,
    actionTimeline: bounded.actionTimeline,
  };
  const dropped: Record<(typeof shedOrder)[number], number> = {
    interactiveElements: 0,
    consoleEntries: 0,
    networkEntries: 0,
    actionTimeline: 0,
  };
  let text = encodeJsonText({ ...bounded, ...lists });
  while (utf8Length(text) > MAX_SNAPSHOT_TEXT_BYTES) {
    // Elements carry the locators, so they go last; logs shed newest-last.
    const key =
      shedOrder.find(
        (candidate) => candidate !== "interactiveElements" && lists[candidate].length > 0,
      ) ?? (lists.interactiveElements.length > 0 ? "interactiveElements" : undefined);
    if (key === undefined) break;
    const keep = Math.floor(lists[key].length / 2);
    dropped[key] += lists[key].length - keep;
    // slice(-0) keeps everything, so spell out the empty case.
    lists[key] =
      keep === 0
        ? []
        : key === "interactiveElements"
          ? lists[key].slice(0, keep)
          : lists[key].slice(-keep);
    text = encodeJsonText({ ...bounded, ...lists });
  }
  for (const key of shedOrder) {
    if (dropped[key] > 0) {
      omitted.push(`${dropped[key]} of ${bounded[key].length} ${key}`);
    }
  }
  return { text, omitted };
};

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
      },
    },
    content: [{ type: "text", text: `Preview snapshot failed: ${errorTag}.` }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const snapshotHandlerContext = yield* Effect.context<
    | ServerConfig.ServerConfig
    | ThreadManagementService.ThreadManagementService
    | ProjectService.ProjectService
    | WorkspacePaths.WorkspacePaths
    | FileSystem.FileSystem
    | Path.Path
  >();
  const built = yield* PreviewSnapshotToolkit;
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideContext(snapshotHandlerContext),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: ({ encodedResult }) => {
              const snapshot = encodedResult as SnapshotMetadata & {
                readonly screenshot: {
                  readonly mimeType: "image/png";
                  readonly data: string;
                  readonly width: number;
                  readonly height: number;
                };
                readonly [key: string]: unknown;
              };
              const { screenshot, ...page } = snapshot;
              const metadata = {
                ...page,
                screenshot: {
                  mimeType: screenshot.mimeType,
                  width: screenshot.width,
                  height: screenshot.height,
                },
              };
              const bounded = boundSnapshotMetadata(metadata);
              return Effect.succeed(
                new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: metadata,
                  content: [
                    { type: "text", text: bounded.text },
                    ...(bounded.omitted.length
                      ? [
                          {
                            type: "text" as const,
                            text: `Snapshot text was bounded. Omitted: ${bounded.omitted.join("; ")}.`,
                          },
                        ]
                      : []),
                    ...(payload?.includeImage === false
                      ? []
                      : [
                          {
                            type: "image" as const,
                            data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                            mimeType: screenshot.mimeType,
                          },
                        ]),
                  ],
                }),
              );
            },
          }),
        );
      }),
  });
});

const PreviewStandardToolkitRegistrationLive = McpServer.toolkit(PreviewStandardToolkit).pipe(
  Layer.provide(PreviewStandardToolkitHandlersLive),
);

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
);

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
);

export const OrchestratorToolkitRegistrationLive = McpServer.toolkit(OrchestratorToolkit).pipe(
  Layer.provide(OrchestratorToolkitHandlersLive),
  Layer.provide(OrchestratorMcpService.layer),
);

export const WorktreeToolkitRegistrationLive = McpServer.toolkit(WorktreeToolkit).pipe(
  Layer.provide(WorktreeToolkitHandlersLive),
  Layer.provide(WorktreeMcpService.layer),
);

export const PullRequestsToolkitRegistrationLive = McpServer.toolkit(PullRequestsToolkit).pipe(
  Layer.provide(PullRequestsToolkitHandlersLive),
  Layer.provide(PullRequestMcpService.layer),
);

const McpTransportLive = McpServer.layerHttp({
  name: "T3 Code",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(McpAuthMiddlewareLive));

export const layer = Layer.mergeAll(
  PreviewToolkitRegistrationLive,
  OrchestratorToolkitRegistrationLive,
  WorktreeToolkitRegistrationLive,
  PullRequestsToolkitRegistrationLive,
).pipe(Layer.provideMerge(McpTransportLive));
