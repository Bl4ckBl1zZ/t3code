import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
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

import { respondToAuthError } from "../auth/http.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { normalizeDispatchCommand } from "../orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { browserAgentRegistry } from "./registry.ts";

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

export const browserAgentRouteLayer = Layer.unwrap(
  Effect.succeed(
    HttpRouter.add(
      "GET",
      "/browser-agent/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const orchestrationEngine = yield* OrchestrationEngineService;
        const startup = yield* ServerRuntimeStartup;
        const crypto = yield* Crypto.Crypto;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request);
        const socket = yield* Effect.orDie(request.upgrade);
        const writer = yield* socket.writer;

        const connectionId = browserAgentRegistry.connect({
          sessionId: session.sessionId,
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
                  ...(message.annotation.pageTitle
                    ? { pageTitle: message.annotation.pageTitle }
                    : {}),
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
          sessions.markConnected(session.sessionId),
          () => socket.runString(handleFrame).pipe(Effect.orDie),
          () =>
            sessions
              .markDisconnected(session.sessionId)
              .pipe(
                Effect.andThen(Effect.sync(() => browserAgentRegistry.disconnect(connectionId))),
              ),
        ).pipe(Effect.as(HttpServerResponse.empty()));
      }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
    ),
  ),
);
