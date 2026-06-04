import type { EnvironmentId, ThreadId, BrowserAgentThreadTabInputEvent } from "@t3tools/contracts";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import { browserAgentRegistry, type BrowserAgentRegistry } from "../browserAgents/registry.ts";

type DynamicToolSpec = EffectCodexSchema.V2ThreadStartParams__DynamicToolSpec;
type DynamicToolCallParams = EffectCodexSchema.ServerRequest__DynamicToolCallParams;
type DynamicToolCallResponse = EffectCodexSchema.DynamicToolCallResponse;
type DynamicToolContentItem =
  EffectCodexSchema.DynamicToolCallResponse__DynamicToolCallOutputContentItem;

const browserToolNames = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_scroll",
  "browser_screenshot",
  "browser_current_page",
]);

const objectSchema = {
  type: "object",
  additionalProperties: false,
} as const;

class BrowserDynamicToolInputError extends Schema.TaggedErrorClass<BrowserDynamicToolInputError>()(
  "BrowserDynamicToolInputError",
  {
    message: Schema.String,
  },
) {}

export const CODEX_BROWSER_DYNAMIC_TOOLS: ReadonlyArray<DynamicToolSpec> = [
  {
    name: "browser_navigate",
    description: "Navigate the browser tab linked to this T3 Code thread to a URL.",
    inputSchema: {
      ...objectSchema,
      properties: {
        url: { type: "string", description: "Absolute URL or browser-supported URL to open." },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Return an accessibility-like snapshot with stable element refs for the linked browser tab.",
    inputSchema: objectSchema,
  },
  {
    name: "browser_click",
    description:
      "Click an element in the linked browser tab by snapshot ref or screenshot coordinates.",
    inputSchema: {
      ...objectSchema,
      properties: {
        ref: { type: "string", description: "Element ref from browser_snapshot." },
        x: { type: "number", description: "Screenshot x coordinate." },
        y: { type: "number", description: "Screenshot y coordinate." },
        button: {
          type: "string",
          enum: ["left", "middle", "right"],
          description: "Mouse button. Defaults to left.",
        },
      },
    },
  },
  {
    name: "browser_type",
    description: "Type text into the currently focused element in the linked browser tab.",
    inputSchema: {
      ...objectSchema,
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "browser_press_key",
    description: "Press a key in the linked browser tab.",
    inputSchema: {
      ...objectSchema,
      properties: {
        key: { type: "string", description: "KeyboardEvent key value, for example Enter." },
      },
      required: ["key"],
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the linked browser tab.",
    inputSchema: {
      ...objectSchema,
      properties: {
        deltaX: { type: "number", description: "Horizontal scroll delta. Defaults to 0." },
        deltaY: { type: "number", description: "Vertical scroll delta. Defaults to 700." },
        x: { type: "number", description: "Optional screenshot x coordinate." },
        y: { type: "number", description: "Optional screenshot y coordinate." },
      },
    },
  },
  {
    name: "browser_screenshot",
    description: "Return a screenshot of the linked browser tab.",
    inputSchema: objectSchema,
  },
  {
    name: "browser_current_page",
    description: "Return URL, title, lifecycle, and capture state for the linked browser tab.",
    inputSchema: objectSchema,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readRequiredString(args: Record<string, unknown>, key: string): string {
  const value = readString(args, key);
  if (!value) {
    throw new Error(`browser tool argument '${key}' must be a non-empty string.`);
  }
  return value;
}

function readNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readButton(args: Record<string, unknown>): "left" | "middle" | "right" {
  const value = args.button;
  return value === "middle" || value === "right" ? value : "left";
}

function dataUrlFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const dataUrl = payload.dataUrl;
  return typeof dataUrl === "string" && dataUrl.startsWith("data:image/") ? dataUrl : null;
}

function textContent(value: string): DynamicToolContentItem {
  return { type: "inputText", text: value };
}

function jsonContent(value: unknown): DynamicToolContentItem {
  return textContent(JSON.stringify(value, null, 2));
}

function toolResult(contentItems: ReadonlyArray<DynamicToolContentItem>, success = true) {
  return { success, contentItems } satisfies DynamicToolCallResponse;
}

function failureResult(error: unknown): DynamicToolCallResponse {
  return toolResult(
    [
      jsonContent({
        ok: false,
        error: error instanceof Error ? error.message : "Browser tool failed.",
      }),
    ],
    false,
  );
}

function parseToolInput<A>(parse: () => A): Effect.Effect<A, BrowserDynamicToolInputError, never> {
  try {
    return Effect.succeed(parse());
  } catch (error) {
    return Effect.fail(
      new BrowserDynamicToolInputError({
        message: error instanceof Error ? error.message : "Invalid browser tool input.",
      }),
    );
  }
}

function threadLinkInput(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  return {
    environmentId: input.environmentId,
    threadId: input.threadId,
  };
}

function currentPagePayload(input: {
  readonly registry: BrowserAgentRegistry;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const link = input.registry.resolveThreadWorkspaceLink(threadLinkInput(input));
  return {
    ok: true,
    url: link?.url ?? null,
    title: link?.title ?? null,
    tabStatus: link?.tabStatus ?? null,
    captureState: link?.captureState ?? null,
    controlState: link?.controlState ?? null,
    expectedOrigin: link?.expectedOrigin ?? null,
    browserLabel: link?.browserLabel ?? null,
  };
}

function clickInput(args: Record<string, unknown>): BrowserAgentThreadTabInputEvent {
  const ref = readString(args, "ref");
  const x = readNumber(args, "x");
  const y = readNumber(args, "y");
  if (!ref && (x === undefined || y === undefined)) {
    throw new Error("browser_click requires either a snapshot ref or x/y coordinates.");
  }
  return {
    type: "click",
    button: readButton(args),
    ...(ref ? { ref: TrimmedNonEmptyString.make(ref) } : {}),
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
  };
}

function scrollInput(args: Record<string, unknown>): BrowserAgentThreadTabInputEvent {
  return {
    type: "scroll",
    deltaX: readNumber(args, "deltaX") ?? 0,
    deltaY: readNumber(args, "deltaY") ?? 700,
    ...(readNumber(args, "x") !== undefined ? { x: readNumber(args, "x") } : {}),
    ...(readNumber(args, "y") !== undefined ? { y: readNumber(args, "y") } : {}),
  };
}

export function handleCodexBrowserDynamicToolCall(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId: ThreadId;
  readonly payload: DynamicToolCallParams;
  readonly registry?: BrowserAgentRegistry;
}): Effect.Effect<DynamicToolCallResponse, never> {
  const registry = input.registry ?? browserAgentRegistry;
  const environmentId = input.environmentId;
  const args = isRecord(input.payload.arguments) ? input.payload.arguments : {};

  if (!browserToolNames.has(input.payload.tool)) {
    return Effect.succeed(
      toolResult(
        [jsonContent({ ok: false, error: `Unknown browser tool '${input.payload.tool}'.` })],
        false,
      ),
    );
  }

  if (!environmentId) {
    return Effect.succeed(
      toolResult(
        [
          jsonContent({
            ok: false,
            error: "T3 environment id is unavailable for browser tool authorization.",
          }),
        ],
        false,
      ),
    );
  }

  const linkInput = threadLinkInput({ environmentId, threadId: input.threadId });
  return Effect.gen(function* () {
    yield* registry.validateAgentBrowserAccess(linkInput);

    switch (input.payload.tool) {
      case "browser_current_page":
        return toolResult([
          jsonContent(currentPagePayload({ registry, environmentId, threadId: input.threadId })),
        ]);

      case "browser_navigate": {
        const url = yield* parseToolInput(() => readRequiredString(args, "url"));
        yield* registry.navigateThreadTab({
          ...linkInput,
          url,
        });
        return toolResult([
          jsonContent(currentPagePayload({ registry, environmentId, threadId: input.threadId })),
        ]);
      }

      case "browser_snapshot": {
        const result = yield* registry.snapshotThreadTab(linkInput);
        return toolResult([jsonContent(result.payload ?? { ok: true })]);
      }

      case "browser_click": {
        const click = yield* parseToolInput(() => clickInput(args));
        yield* registry.inputThreadTab({
          ...linkInput,
          input: click,
        });
        return toolResult([jsonContent({ ok: true })]);
      }

      case "browser_type": {
        const text = yield* parseToolInput(() => readRequiredString(args, "text"));
        yield* registry.inputThreadTab({
          ...linkInput,
          input: {
            type: "type",
            text,
          },
        });
        return toolResult([jsonContent({ ok: true })]);
      }

      case "browser_press_key": {
        const key = yield* parseToolInput(() => readRequiredString(args, "key"));
        yield* registry.inputThreadTab({
          ...linkInput,
          input: {
            type: "key",
            key: TrimmedNonEmptyString.make(key),
          },
        });
        return toolResult([jsonContent({ ok: true })]);
      }

      case "browser_scroll": {
        const scroll = yield* parseToolInput(() => scrollInput(args));
        yield* registry.inputThreadTab({
          ...linkInput,
          input: scroll,
        });
        return toolResult([jsonContent({ ok: true })]);
      }

      case "browser_screenshot": {
        const result = yield* registry.screenshotThreadTab(linkInput);
        const dataUrl = dataUrlFromPayload(result.payload);
        return toolResult([
          jsonContent(result.payload ?? { ok: true }),
          ...(dataUrl ? [{ type: "inputImage" as const, imageUrl: dataUrl }] : []),
        ]);
      }

      default:
        return toolResult(
          [jsonContent({ ok: false, error: `Unknown browser tool '${input.payload.tool}'.` })],
          false,
        );
    }
  }).pipe(Effect.catch((error) => Effect.succeed(failureResult(error))));
}
