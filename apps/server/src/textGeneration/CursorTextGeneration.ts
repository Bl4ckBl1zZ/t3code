import "../provider/cursorShellSpawnGuard.ts";
import type { AgentOptions, RunResult } from "@cursor/sdk";
import { Agent } from "../provider/cursorSdk.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type CursorSettings, type ProviderSetupError } from "@t3tools/contracts";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGenerationOperations from "./TextGenerationOperations.ts";
import { cursorSdkModelSelection } from "../provider/cursorSdkModel.ts";
import type { CursorAuth } from "../provider/CursorAuth.ts";

const CURSOR_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

function emptyCursorSdkResultDetail(result: RunResult): string {
  switch (result.status) {
    case "cancelled":
      return "Cursor SDK request was cancelled.";
    case "error":
      return "Cursor SDK request finished with an error and no output.";
    case "finished":
      return "Cursor SDK returned empty output.";
  }
}

/**
 * Build a Cursor text-generation closure bound to a specific `CursorSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
export const makeCursorTextGeneration = Effect.fn("makeCursorTextGeneration")((
  cursorSettings: CursorSettings,
  environment?: NodeJS.ProcessEnv,
  resolveApiKey?: Effect.Effect<string, ProviderSetupError>,
  withAccess?: CursorAuth["withAccess"],
) => {
  const resolvedEnvironment = environment ?? process.env;

  const resolveCursorApiKey = (operation: TextGenerationOperations.Operation) =>
    Effect.gen(function* () {
      if (!cursorSettings.enabled) {
        return yield* new TextGenerationError({
          operation,
          detail: "Cursor is disabled in T3 Code settings.",
        });
      }

      const apiKey = resolveApiKey
        ? yield* resolveApiKey
        : resolvedEnvironment.CURSOR_API_KEY?.trim();
      if (!apiKey) {
        return yield* new TextGenerationError({
          operation,
          detail: "Sign in with Cursor or add CURSOR_API_KEY in provider settings.",
        });
      }

      return apiKey;
    });

  const runCursorJson: TextGenerationOperations.Runner = (request) => {
    const { operation, cwd, prompt, modelSelection } = request;
    return Effect.gen(function* () {
      const apiKey = yield* resolveCursorApiKey(operation);
      const agentOptions = {
        apiKey,
        mode: "agent",
        model: cursorSdkModelSelection(modelSelection),
        local: {
          cwd,
          autoReview: false,
          sandboxOptions: { enabled: false },
          enableAgentRetries: true,
        },
      } satisfies AgentOptions;

      const promptResult = yield* Effect.tryPromise({
        try: () => Agent.prompt(prompt, agentOptions),
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Cursor SDK request failed.",
            cause,
          }),
      }).pipe(
        Effect.timeoutOption(CURSOR_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Cursor SDK request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );

      const rawResult = promptResult.result?.trim() ?? "";
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation,
          detail: emptyCursorSdkResultDetail(promptResult),
        });
      }

      return yield* TextGenerationOperations.decodeJsonReply(request, "Cursor SDK", rawResult);
    }).pipe(
      (effect) => (withAccess ? withAccess(effect) : effect),
      Effect.scoped,
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Cursor SDK text generation failed.",
              cause,
            }),
      ),
    );
  };

  return Effect.succeed(TextGenerationOperations.fromRunner("CursorTextGeneration", runCursorJson));
});
