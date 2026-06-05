import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";

import {
  AuthSessionId,
  BrowserAgentInboundMessage,
  BrowserAgentCommandError,
  BrowserAgentOutboundMessage,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type BrowserAgentAnnotationSubmittedMessage,
  MessageId,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import { BROWSER_AGENT_LOCAL_CONTROL_WS_PATH } from "@t3tools/shared/browserAgent";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../auth/http.ts";
import { ServerConfig } from "../config.ts";
import { normalizeDispatchCommand } from "../orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { browserAgentRegistry, LOCAL_BROWSER_AGENT_SESSION_ID } from "./registry.ts";

function estimateDataUrlByteSize(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  const payload = commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function readDataUrlMimeType(dataUrl: string): string {
  const match = /^data:([^;,]+)[;,]/i.exec(dataUrl);
  return match?.[1]?.toLowerCase() ?? "image/png";
}

function buildAnnotationPrompt(input: {
  readonly text: string;
  readonly pageUrl: string;
  readonly pageTitle?: string;
  readonly selectorLabel?: string;
}): string {
  const details = [
    `Page: ${input.pageTitle?.trim() || "Untitled page"}`,
    `URL: ${input.pageUrl}`,
    ...(input.selectorLabel?.trim() ? [`Element: ${input.selectorLabel.trim()}`] : []),
  ];
  return `${input.text.trim()}\n\nBrowser annotation:\n${details
    .map((detail) => `- ${detail}`)
    .join("\n")}`;
}

const decodeBrowserAgentMessage = Schema.decodeEffect(
  Schema.fromJsonString(BrowserAgentInboundMessage),
);
const encodeBrowserAgentMessage = Schema.encodeEffect(
  Schema.fromJsonString(BrowserAgentOutboundMessage),
);

function normalizeRequestAddress(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

function remoteAddressFromRequestSource(source: unknown): string | null {
  if (!source || typeof source !== "object") {
    return null;
  }
  const candidate = source as {
    readonly remoteAddress?: string | null;
    readonly socket?: {
      readonly remoteAddress?: string | null;
    };
  };
  return normalizeRequestAddress(candidate.socket?.remoteAddress ?? candidate.remoteAddress);
}

function isLoopbackRemoteAddress(address: string | null): boolean {
  return (
    address === "localhost" ||
    address === "::1" ||
    address === "0:0:0:0:0:0:0:1" ||
    address === "127.0.0.1" ||
    Boolean(address?.startsWith("127."))
  );
}

const handleBrowserAgentSocket = (input: {
  readonly sessionId: AuthSessionId;
  readonly markSessionConnected: boolean;
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const sessions = yield* SessionStore.SessionStore;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const startup = yield* ServerRuntimeStartup;
    const crypto = yield* Crypto.Crypto;
    const socket = yield* Effect.orDie(request.upgrade);
    const writer = yield* socket.writer;

    const connectionId = browserAgentRegistry.connect({
      sessionId: input.sessionId,
      send: (message) =>
        encodeBrowserAgentMessage(message).pipe(
          Effect.flatMap((encoded) => writer(encoded)),
          Effect.mapError(
            (cause) =>
              new BrowserAgentCommandError({
                code: "command-failed",
                message: "Failed to send command to the browser extension.",
                cause,
              }),
          ),
          Effect.asVoid,
        ),
    });

    const randomUUID = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: "Failed to generate browser annotation command id.",
            cause,
          }),
      ),
    );

    const dispatchAnnotation = (message: BrowserAgentAnnotationSubmittedMessage) =>
      Effect.gen(function* () {
        const link = browserAgentRegistry.resolveWorkspaceLink(message.workspaceLinkId);
        if (!link) {
          yield* Effect.logWarning("Browser annotation submitted for unknown workspace link", {
            workspaceLinkId: message.workspaceLinkId,
          });
          return;
        }

        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const commandUuid = yield* randomUUID;
        const messageUuid = yield* randomUUID;
        const mimeType = readDataUrlMimeType(message.annotation.screenshotDataUrl);
        const normalizedCommand = yield* normalizeDispatchCommand({
          type: "thread.turn.start",
          commandId: CommandId.make(`browser-annotation:${commandUuid}`),
          threadId: link.threadId,
          message: {
            messageId: MessageId.make(`browser-annotation:${messageUuid}`),
            role: "user",
            text: buildAnnotationPrompt({
              text: message.annotation.text,
              pageUrl: message.annotation.pageUrl,
              ...(message.annotation.pageTitle ? { pageTitle: message.annotation.pageTitle } : {}),
              ...(message.annotation.selectorLabel
                ? { selectorLabel: message.annotation.selectorLabel }
                : {}),
            }),
            attachments: [
              {
                type: "image",
                name: "browser-annotation.png",
                mimeType,
                sizeBytes: estimateDataUrlByteSize(message.annotation.screenshotDataUrl),
                dataUrl: message.annotation.screenshotDataUrl,
              },
            ],
          },
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          deliveryMode: "queue",
          createdAt,
        });

        yield* startup.enqueueCommand(
          orchestrationEngine.dispatch(normalizedCommand).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationDispatchCommandError({
                  message: "Failed to dispatch browser annotation.",
                  cause,
                }),
            ),
          ),
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to process browser annotation", {
            error: error.message,
            workspaceLinkId: message.workspaceLinkId,
          }),
        ),
      );

    const handleFrame = (rawFrame: string) =>
      Effect.gen(function* () {
        const message = yield* decodeBrowserAgentMessage(rawFrame).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Invalid browser agent websocket message", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
        if (!message) {
          return;
        }

        browserAgentRegistry.handleMessage(connectionId, message);
        if (message.type === "browserAgent.annotation.submitted") {
          yield* dispatchAnnotation(message);
        }
      });

    return yield* Effect.acquireUseRelease(
      input.markSessionConnected ? sessions.markConnected(input.sessionId) : Effect.void,
      () => socket.runString(handleFrame).pipe(Effect.orDie),
      () =>
        (input.markSessionConnected
          ? sessions.markDisconnected(input.sessionId)
          : Effect.void
        ).pipe(Effect.andThen(Effect.sync(() => browserAgentRegistry.disconnect(connectionId)))),
    ).pipe(Effect.as(HttpServerResponse.empty()));
  });

const authenticatedBrowserAgentRouteLayer = HttpRouter.add(
  "GET",
  "/browser-agent/ws",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
      Effect.catchTags({
        ServerAuthInvalidCredentialError: (error) => failEnvironmentAuthInvalid(error.reason),
        ServerAuthInternalError: (error) => failEnvironmentInternal("internal_error", error),
      }),
    );
    return yield* handleBrowserAgentSocket({
      sessionId: session.sessionId,
      markSessionConnected: true,
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
    }),
  ),
);

const localBrowserAgentRouteLayer = HttpRouter.add(
  "GET",
  BROWSER_AGENT_LOCAL_CONTROL_WS_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    if (config.mode !== "desktop") {
      return HttpServerResponse.jsonUnsafe(
        { error: "Local browser control is only available in desktop mode." },
        { status: 404 },
      );
    }
    if (!isLoopbackRemoteAddress(remoteAddressFromRequestSource(request.source))) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Local browser control is only available from this computer." },
        { status: 403 },
      );
    }
    return yield* handleBrowserAgentSocket({
      sessionId: LOCAL_BROWSER_AGENT_SESSION_ID,
      markSessionConnected: false,
    });
  }),
);

export const browserAgentRouteLayer = Layer.mergeAll(
  authenticatedBrowserAgentRouteLayer,
  localBrowserAgentRouteLayer,
);
