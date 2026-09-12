import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PreviewTabId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const testWorkspaceRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcp-snapshot-test-"));
const invocation = {
  credentialId: "credential-mcp-test",
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  audience: "urn:t3-code:mcp:environment-mcp-test",
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const projectId = ProjectId.make("project-mcp-test");
const stubThreadManagementLayer = Layer.mock(ThreadManagementService)({
  getThreadProjection: (projectionThreadId) =>
    projectionThreadId === threadId
      ? Effect.succeed({
          thread: {
            id: threadId,
            projectId,
            worktreePath: null,
            archivedAt: null,
            deletedAt: null,
          },
        } as OrchestrationV2ThreadProjection)
      : Effect.die("unused"),
} satisfies Partial<ThreadManagementService["Service"]>);
const stubProjectServiceLayer = Layer.mock(ProjectService.ProjectService)({
  getById: (lookupProjectId) =>
    Effect.succeed(
      lookupProjectId === projectId
        ? Option.some({ id: projectId, workspaceRoot: testWorkspaceRoot } as Project)
        : Option.none(),
    ),
} satisfies Partial<ProjectService.ProjectService["Service"]>);
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
  Layer.provideMerge(stubThreadManagementLayer),
  Layer.provideMerge(stubProjectServiceLayer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-http-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("returns bounded structural preview snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "sensitive renderer failure",
                detail: { consoleOutput: "sensitive browser output" },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([
        { type: "text", text: "Preview snapshot failed: PreviewAutomationExecutionError." },
      ]);
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: "PreviewAutomationExecutionError",
          operation: "snapshot",
          failureCount: 1,
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18],
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : event.request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);
      expect(clickTool?.tool.outputSchema).toEqual({
        type: "object",
        additionalProperties: false,
        description: "The preview action completed successfully.",
      });

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(malformed._tag).toBe("InvalidParams");

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const actionRequests = [
        { name: "preview_click", arguments: { x: 10, y: 10 } },
        { name: "preview_type", arguments: { text: "Hello" } },
        { name: "preview_press", arguments: { key: "Enter" } },
        { name: "preview_scroll", arguments: { deltaY: 100 } },
        { name: "preview_wait_for", arguments: { text: "Example" } },
      ];
      for (const request of actionRequests) {
        const result = yield* server
          .callTool(request)
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({});
        expect(result.content).toEqual([{ type: "text", text: "{}" }]);
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("saves snapshot screenshots without returning raw base64 metadata", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-save-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-save-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: true,
              result: {
                url: "http://example.test/",
                title: "Example",
                loading: false,
                visibleText: "Example",
                interactiveElements: [],
                accessibilityTree: {},
                consoleEntries: [],
                networkEntries: [],
                actionTimeline: [],
                screenshot: {
                  mimeType: "image/png",
                  data: Buffer.from("png-bytes").toString("base64"),
                  width: 10,
                  height: 5,
                },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const callSnapshot = (arguments_: Record<string, unknown>) =>
        server
          .callTool({ name: "preview_snapshot", arguments: arguments_ })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

      const saved = yield* callSnapshot({ savePath: "evidence/login.png" });
      expect(saved.isError).toBe(false);
      expect(saved.structuredContent).toMatchObject({
        savedScreenshotPath: "evidence/login.png",
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(
        (saved.structuredContent as { screenshot?: { data?: unknown } }).screenshot?.data,
      ).toBeUndefined();
      expect(
        NodeFS.readFileSync(NodePath.join(testWorkspaceRoot, "evidence/login.png"), "utf8"),
      ).toBe("png-bytes");

      expect((yield* callSnapshot({ savePath: "../outside.png" })).isError).toBe(true);
      const outsideDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcp-outside-"));
      NodeFS.symlinkSync(outsideDir, NodePath.join(testWorkspaceRoot, "escape-dir"));
      expect((yield* callSnapshot({ savePath: "escape-dir/sub/leak.png" })).isError).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(outsideDir, "sub"))).toBe(false);

      const victimPath = NodePath.join(outsideDir, "victim.png");
      NodeFS.writeFileSync(victimPath, "original");
      NodeFS.symlinkSync(victimPath, NodePath.join(testWorkspaceRoot, "evidence", "escape.png"));
      expect((yield* callSnapshot({ savePath: "evidence/escape.png" })).isError).toBe(true);
      expect(NodeFS.readFileSync(victimPath, "utf8")).toBe("original");

      const danglingTarget = NodePath.join(outsideDir, "not-created.png");
      NodeFS.symlinkSync(
        danglingTarget,
        NodePath.join(testWorkspaceRoot, "evidence", "dangling.png"),
      );
      expect((yield* callSnapshot({ savePath: "evidence/dangling.png" })).isError).toBe(true);
      expect(NodeFS.existsSync(danglingTarget)).toBe(false);

      expect((yield* callSnapshot({ save: true, savePath: "evidence/login.png" })).isError).toBe(
        true,
      );

      const artifact = yield* callSnapshot({ save: true });
      expect(artifact.isError).toBe(false);
      const artifactPath = (artifact.structuredContent as { savedScreenshotPath?: string })
        .savedScreenshotPath;
      const config = yield* ServerConfig.ServerConfig;
      expect(artifactPath).toBeDefined();
      expect(NodePath.dirname(artifactPath!)).toBe(config.browserArtifactsDir);
      expect(NodeFS.readFileSync(artifactPath!, "utf8")).toBe("png-bytes");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const snapshotResult = {
  url: "http://example.test/",
  title: "Example",
  loading: false,
  visibleText: "Example",
  interactiveElements: [],
  accessibilityTree: {},
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: {
    mimeType: "image/png",
    data: Buffer.from("png").toString("base64"),
    width: 10,
    height: 5,
  },
};

/** Answers every preview request on a fresh broker host with the given result. */
const serveSnapshots = (clientId: string, result: unknown) =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const connected = yield* Deferred.make<void>();
    const inputs: Array<unknown> = [];
    const events = yield* broker.connect({ clientId, environmentId });
    yield* Stream.runForEach(events, (event) => {
      if (event.type === "connected") return Deferred.succeed(connected, undefined);
      inputs.push(event.request.input);
      return broker.respond({
        clientId,
        connectionId: event.connectionId,
        requestId: event.request.requestId,
        ok: true,
        result,
      });
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
    return inputs;
  });

const callSnapshot = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "preview_snapshot", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect.each([
  { mode: "default", input: {}, images: true },
  { mode: "explicit image", input: { includeImage: true }, images: true },
  { mode: "text only", input: { includeImage: false }, images: false },
])("returns fresh $mode snapshots on repeated MCP calls", ({ input, images }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
      const page = {
        url: "http://example.test/",
        loading: false,
        visibleText: "Save your changes",
        interactiveElements: [
          {
            tag: "button",
            role: "button",
            name: "Save",
            selector: "#save",
            x: 0,
            y: 0,
            width: 20,
            height: 10,
          },
        ],
        accessibilityTree: { role: "document", name: "Example" },
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
      };
      const screenshot = { mimeType: "image/png", width: 1, height: 1 };
      let requests = 0;
      const events = yield* broker.connect({ clientId: "mcp-image-option-client", environmentId });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        requests += 1;
        expect(event.request).toMatchObject({
          operation: "snapshot",
          tabId: alternateTabId,
          threadId,
        });
        expect(event.request.input).toEqual({});
        return broker.respond({
          clientId: "mcp-image-option-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: {
            ...page,
            title: `Snapshot ${requests}`,
            screenshot: { ...screenshot, data: png },
          },
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      for (const call of [1, 2, 3, 4, 5, 6]) {
        const snapshot = yield* server
          .callTool({
            name: "preview_snapshot",
            arguments: { ...input, tabId: alternateTabId },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        const metadata = { ...page, title: `Snapshot ${call}`, screenshot };
        const { accessibilityTree: _tree, ...boundedMetadata } = metadata;
        expect(snapshot.isError).toBe(false);
        expect(snapshot.structuredContent).toEqual(metadata);
        const [text, ...rest] = snapshot.content;
        expect(text?.type === "text" ? decodeJsonText(text.text) : null).toEqual(boundedMetadata);
        expect(rest).toEqual([
          {
            type: "text",
            text: "Snapshot text was bounded. Omitted: accessibilityTree (use interactiveElements locators or preview_evaluate).",
          },
          ...(images
            ? [
                {
                  type: "image",
                  mimeType: "image/png",
                  data: new Uint8Array(Buffer.from(png, "base64")),
                },
              ]
            : []),
        ]);
      }

      // Output selection belongs to this call, not the MCP session's history.
      const nextDefault = yield* server
        .callTool({
          name: "preview_snapshot",
          arguments: { tabId: alternateTabId },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(nextDefault.content.map((content) => content.type)).toEqual(["text", "text", "image"]);
      expect(nextDefault.structuredContent).toEqual({ ...page, title: "Snapshot 7", screenshot });
      expect(requests).toBe(7);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects non-boolean snapshot image options before selecting a browser host", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const includeImage of ["false", 0, null]) {
      const result = yield* server
        .callTool({
          name: "preview_snapshot",
          arguments: { includeImage },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "Preview snapshot failed: AiError." }]);
      expect(result.structuredContent).toEqual({
        error: { _tag: "AiError", operation: "snapshot", failureCount: 1 },
      });
    }
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps the snapshot text under the agent's output ceiling", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // Mirrors the real failure: a [role] container whose innerText is the whole
      // project list, repeated for several elements, plus a big AX tree.
      const pageText = "/Users/theo/Code/project\nClaude, Codex · 79 threads\n".repeat(600);
      const element = (name: string, index: number) => ({
        tag: "div",
        role: "presentation",
        name,
        selector: `div:nth-of-type(${index})`,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      });
      const oversized = {
        ...snapshotResult,
        visibleText: pageText,
        interactiveElements: [
          element(pageText, 1),
          element(pageText, 2),
          element(pageText, 3),
          element("Continue", 4),
        ],
        accessibilityTree: { nodes: Array.from({ length: 2_000 }, (_, i) => ({ nodeId: `${i}` })) },
        consoleEntries: Array.from({ length: 100 }, (_, i) => ({
          level: "log",
          text: `entry ${i}`,
          timestamp: "t",
        })),
      };
      yield* serveSnapshots("mcp-bounded-client", oversized);

      const snapshot = yield* callSnapshot({ includeImage: false });

      expect(snapshot.isError).toBe(false);
      const [text, notice] = snapshot.content;
      expect(text?.type).toBe("text");
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly accessibilityTree?: unknown;
        readonly visibleText: string;
        readonly interactiveElements: ReadonlyArray<{ readonly name: string }>;
        readonly consoleEntries: ReadonlyArray<{ readonly text: string }>;
      };
      expect(parsed.accessibilityTree).toBeUndefined();
      expect(parsed.visibleText.length).toBeLessThanOrEqual(8_001);
      expect(parsed.interactiveElements).toHaveLength(4);
      expect(parsed.interactiveElements[0]?.name.length).toBeLessThanOrEqual(201);
      expect(parsed.interactiveElements[3]?.name).toBe("Continue");
      expect(parsed.consoleEntries).toHaveLength(40);
      expect(parsed.consoleEntries[0]?.text).toBe("entry 60");
      expect(notice?.type === "text" ? notice.text : "").toContain("accessibilityTree");
      expect(notice?.type === "text" ? notice.text : "").toContain("60 older console entries");
      // The structured result is untouched; only the text the agent reads is bounded.
      expect(snapshot.structuredContent).toMatchObject({
        accessibilityTree: oversized.accessibilityTree,
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("bounds the snapshot text even when nothing but logs and the title are large", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const oversized = {
        ...snapshotResult,
        title: "t".repeat(70_000),
        interactiveElements: [],
        consoleEntries: [{ level: "log", text: "x".repeat(70_000), timestamp: "t" }],
      };
      yield* serveSnapshots("mcp-bounded-logs-client", oversized);

      const snapshot = yield* callSnapshot({ includeImage: false });

      const [text] = snapshot.content;
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly title: string;
        readonly consoleEntries: ReadonlyArray<{ readonly text: string }>;
      };
      expect(parsed.title.length).toBe(2_049);
      expect(parsed.consoleEntries[0]?.text.length).toBe(501);
      const notice = snapshot.content[1];
      const noticeText = notice?.type === "text" ? notice.text : "";
      expect(noticeText).toContain("url or title after 2048 characters");
      expect(noticeText).toContain("console entries text after 500 characters");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("sheds log entries before locators when every list is full", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const long = "x".repeat(2_000);
      const oversized = {
        ...snapshotResult,
        interactiveElements: Array.from({ length: 20 }, (_, i) => ({
          tag: "button",
          role: "button",
          name: `Button ${i}`,
          selector: `#button-${i}`,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        })),
        consoleEntries: Array.from({ length: 200 }, () => ({
          level: long,
          text: long,
          timestamp: long,
          source: long,
        })),
        networkEntries: Array.from({ length: 200 }, () => ({
          url: long,
          method: long,
          status: 200,
          failed: false,
          errorText: long,
          timestamp: long,
        })),
        actionTimeline: Array.from({ length: 200 }, () => ({
          id: long,
          action: long,
          status: "succeeded",
          startedAt: long,
          completedAt: long,
          error: long,
        })),
      };
      yield* serveSnapshots("mcp-full-logs-client", oversized);

      const snapshot = yield* callSnapshot({ includeImage: false });

      const [text, notice] = snapshot.content;
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly interactiveElements: ReadonlyArray<unknown>;
        readonly consoleEntries: ReadonlyArray<unknown>;
        readonly networkEntries: ReadonlyArray<unknown>;
        readonly actionTimeline: ReadonlyArray<unknown>;
      };
      // Locators survive; the log lists take the cut.
      expect(parsed.interactiveElements).toHaveLength(20);
      expect(
        parsed.consoleEntries.length + parsed.networkEntries.length + parsed.actionTimeline.length,
      ).toBeLessThan(120);
      const noticeText = notice?.type === "text" ? notice.text : "";
      expect(noticeText).toContain("40 of 40 actionTimeline");
      expect(noticeText).not.toMatch(/\d+ of \d+ interactiveElements/);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect.each([null, 42, "hello", [1, "two"], { nested: true }])(
  "returns an object-shaped MCP evaluate result for %j",
  (value) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* serveSnapshots("mcp-evaluate-client", value);
        const server = yield* McpServer.McpServer;
        const response = yield* server
          .callTool({
            name: "preview_evaluate",
            arguments: { expression: "document.title" },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent).toEqual({ value });
      }),
    ).pipe(Effect.provide(TestLayer)),
);
