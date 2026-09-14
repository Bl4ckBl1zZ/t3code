import {
  HermesWorkError,
  type HermesWorkArtifact,
  type HermesWorkQueryInput,
} from "@t3tools/contracts";
import { Effect, Predicate, Schema } from "effect";
import type { HermesDashboardClient } from "./HermesDashboardClient.ts";

const Session = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  profile: Schema.optional(Schema.String),
  last_active: Schema.optional(Schema.NullOr(Schema.Number)),
  started_at: Schema.optional(Schema.NullOr(Schema.Number)),
});
const Message = Schema.Struct({
  role: Schema.String,
  content: Schema.optional(Schema.Unknown),
  text: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  tool_name: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.NullOr(Schema.Number)),
});
const Sessions = Schema.Struct({ sessions: Schema.Array(Session) });
const Messages = Schema.Struct({ messages: Schema.Array(Message) });
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const decodeSessions = Schema.decodeUnknownEffect(Sessions);
const decodeMessages = Schema.decodeUnknownEffect(Messages);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const DataUrl = Schema.Struct({ dataUrl: Schema.String });
const decodeDataUrl = Schema.decodeUnknownEffect(DataUrl);
const isPath = (value: string) =>
  /^(?:file:|\/|[~.][\\/]|\.\.[\\/]|[a-z]:[\\/]|\\\\)/iu.test(value);
const imagePath = /\.(?:png|jpe?g|gif|webp|svg|bmp)(?:\?.*)?$/iu;
const filePath =
  /\.(?:png|jpe?g|gif|webp|svg|bmp|pdf|txt|json|md|csv|zip|tar|gz|avi|flac|m4a|mkv|mp3|ogg|opus|wav|webm|mp4|mov)(?:\?.*)?$/iu;
const producer =
  /(?:^|_)(?:creat(?:e|ion)|download|export|generat(?:e|ion)|render|save|speech|tts|write)(?:_|$)/iu;
const strongKey =
  /^(?:artifact_(?:file|image|path|url)|files?_(?:created|modified|written)|generated_(?:file|image|path|url)|media_tag|output_(?:file|path|url)|result_(?:file|path|url)|saved_to|screenshot_path)$/iu;
const producerKey =
  /^(?:artifact(?:s|_(?:file|image|path|url))?|attachment(?:s|_(?:file|image|path|url))?|download(?:s|_(?:file|path|url))?|(?:audio|image|video)(?:_(?:file|path|url))?|file_path|local_path|media(?:_(?:file|path|url))?|path)$/iu;
const media = (text: string, add: (value: string) => void) => {
  for (const match of text.matchAll(/MEDIA:\s*(?:`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|(\S+))/gu))
    add(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "");
};
const millis = (value: number | null | undefined) =>
  value && Number.isFinite(value) && value > 0
    ? value < 10_000_000_000
      ? value * 1000
      : value
    : 0;

/** Mirrors the native artifact provenance rules: user attachments and input tool paths are excluded. */
export function collectHermesWorkArtifacts(
  session: typeof Session.Type,
  messages: ReadonlyArray<typeof Message.Type>,
  profile: string,
): HermesWorkArtifact[] {
  const found = new Map<string, HermesWorkArtifact>();
  for (const message of messages) {
    if (message.role !== "assistant" && message.role !== "tool") continue;
    const add = (candidate: string) => {
      const value = candidate.trim().replace(/[),.;`]+$/u, "");
      if (
        !/^https?:\/\//iu.test(value) &&
        !value.startsWith("data:image/") &&
        !(isPath(value) && filePath.test(value))
      )
        return;
      if (found.has(value)) return;
      const kind =
        imagePath.test(value) || value.startsWith("data:image/")
          ? "image"
          : isPath(value)
            ? "file"
            : "link";
      let label = value.split(/[\\/]/u).at(-1) || value;
      try {
        label = new URL(value).pathname.split("/").findLast(Boolean) || label;
      } catch {
        /* Local file path. */
      }
      found.set(value, {
        id: `${profile}:${session.id}:${value}`,
        kind,
        value,
        label,
        sessionId: session.id,
        profile,
        sessionTitle: session.title?.trim() || "Untitled conversation",
        timestamp:
          millis(message.timestamp) || millis(session.last_active) || millis(session.started_at),
      });
    };
    const text = Predicate.isString(message.content)
      ? message.content
      : (message.text ?? message.context ?? "");
    if (message.role === "assistant") {
      media(text, add);
      for (const match of text.matchAll(
        /!?\[[^\]]*\]\(([^)\s]+)\)|https?:\/\/[^\s<>"')]+|(?:^|[\s("'`])((?:\/|~[\\/]|\.\.?[\\/]|[a-z]:[\\/]|\\\\)[^\s"'`<>]+)/giu,
      ))
        add(match[1] ?? match[2] ?? match[0]);
      continue;
    }
    const name = message.tool_name ?? message.name ?? "";
    const produces = producer.test(name) || name.startsWith("bfl_flux3_");
    if (produces) media(text, add);
    if (name === "browser_vision")
      for (const match of text.matchAll(/Screenshot path:\s*([^\r\n<>]+)/giu)) add(match[1] ?? "");
    const visit = (value: unknown, explicit = false, depth = 0): void => {
      if (depth > 20) return;
      if (Predicate.isString(value)) {
        if (explicit) {
          add(value);
          media(value, add);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const entry of value) visit(entry, explicit, depth + 1);
        return;
      }
      if (isRecord(value))
        for (const [key, child] of Object.entries(value))
          visit(
            child,
            explicit || strongKey.test(key) || (produces && producerKey.test(key)),
            depth + 1,
          );
    };
    if (isRecord(message.content) && message.content._multimodal === true)
      visit(message.content.meta);
    else if (!Predicate.isString(message.content)) visit(message.content);
    const unwrapped = text
      .replace(/^<untrusted_tool_result\b[^>]*>\s*/u, "")
      .replace(/<\/untrusted_tool_result>\s*$/u, "");
    for (const candidate of [text, unwrapped, unwrapped.slice(unwrapped.indexOf("\n\n") + 2)]) {
      try {
        visit(decodeJson(candidate));
      } catch {
        /* Plain tool output is not an artifact manifest. */
      }
    }
  }
  return [...found.values()];
}

const invalidResponse = () =>
  new HermesWorkError({
    code: "invalid_response",
    message: "Hermes returned an invalid artifact response.",
  });
export const queryHermesWorkArtifacts = Effect.fn("queryHermesWorkArtifacts")(function* (
  dashboard: HermesDashboardClient["Service"],
  input: HermesWorkQueryInput,
) {
  const request = (path: string, query?: Record<string, string | number>) =>
    dashboard.request({
      providerInstanceId: input.providerInstanceId,
      profile: input.profile,
      method: "GET",
      path,
      ...(query ? { query } : {}),
    });
  if (input.section === "artifact") {
    if (!input.path || !input.id)
      return yield* new HermesWorkError({
        code: "invalid_input",
        message: "Choose an artifact and its originating conversation.",
      });
    const value = yield* request("/api/fs/read-data-url", {
      path: input.path,
      session_id: input.id,
    });
    const preview = yield* decodeDataUrl(value).pipe(Effect.mapError(invalidResponse));
    return { content: preview.dataUrl, path: input.path };
  }
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    return yield* new HermesWorkError({ code: "invalid_input", message: "Invalid artifact page." });
  const value = yield* request("/api/sessions", { limit: 20, offset, order: "recent" });
  const response = yield* decodeSessions(value).pipe(Effect.mapError(invalidResponse));
  const artifacts: HermesWorkArtifact[] = [];
  const diagnostics: string[] = [];
  // Read sequentially so a gallery never loads many transcripts concurrently.
  for (const session of response.sessions) {
    const page = yield* request(`/api/sessions/${encodeURIComponent(session.id)}/messages`, {
      limit: 500,
      order: "latest",
    }).pipe(
      Effect.flatMap((value) => decodeMessages(value).pipe(Effect.mapError(invalidResponse))),
      Effect.map((value) => ({ value, error: null })),
      Effect.catchTag("HermesWorkError", (error) => Effect.succeed({ value: null, error })),
    );
    if (!page.value) {
      diagnostics.push(`Could not load artifacts from ${session.title || session.id}.`);
      continue;
    }
    artifacts.push(...collectHermesWorkArtifacts(session, page.value.messages, input.profile));
    if (page.value.messages.length === 500)
      diagnostics.push(
        `Showing artifacts from the latest 500 messages in ${session.title || session.id}.`,
      );
  }
  artifacts.sort((left, right) => right.timestamp - left.timestamp);
  return {
    artifacts,
    artifactsNextOffset: response.sessions.length === 20 ? offset + 20 : null,
    diagnostics,
  };
});
