import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Preview from "../../../preview/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { PreviewControlsHandlersLive } from "./handlers.ts";
import { PreviewControlsToolkit } from "./tools.ts";

// The credential's capability set is the whole gate. Upstream derives it from a
// per-project `enableAgentBrowserAccess` override we do not have, so the cases
// are stated directly instead of through project settings.
it.effect.each([
  { name: "credential with preview access", granted: true },
  { name: "credential without preview access", granted: false },
])("list and close respect a $name", ({ granted }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("preview-controls-thread");
      const scope: McpInvocationContext.McpInvocationScope = {
        credentialId: "preview-controls-credential",
        audience: "preview-controls",
        environmentId: EnvironmentId.make("preview-controls-environment"),
        threadId,
        providerSessionId: "preview-controls-provider-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(granted ? ["preview"] : []),
        issuedAt: 0,
      };
      const manager = yield* Preview.make;
      const tab = yield* manager.open({ threadId, url: "http://localhost:3000" });
      const dependencies = Layer.mergeAll(
        Layer.succeed(Preview.PreviewManager, manager),
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      );
      const toolkit = yield* PreviewControlsToolkit.pipe(
        Effect.provide(PreviewControlsHandlersLive.pipe(Layer.provide(dependencies))),
      );
      const listed = yield* toolkit
        .handle("t3_preview_list", {})
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      const closed = yield* toolkit
        .handle("t3_preview_close", { tabId: tab.tabId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      if (granted) {
        expect(listed.at(-1)?.result).toMatchObject({ sessions: [tab], nextCursor: null });
        expect(closed.at(-1)?.result).toEqual({});
        expect((yield* manager.list({ threadId })).sessions).toEqual([]);
      } else {
        for (const result of [listed, closed]) {
          expect(result.at(-1)?.result).toMatchObject({
            _tag: "PreviewAutomationUnavailableError",
            capability: "preview",
            threadId,
          });
        }
        // A denied close must not have taken effect.
        expect((yield* manager.list({ threadId })).sessions).toEqual([tab]);
      }
    }),
  ),
);
