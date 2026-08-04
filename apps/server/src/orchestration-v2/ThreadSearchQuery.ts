import {
  IsoDateTime,
  OrchestrationThreadSearchSource,
  ProjectId,
  ThreadId,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export class ThreadSearchQueryError extends Schema.TaggedErrorClass<ThreadSearchQueryError>()(
  "ThreadSearchQueryError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Failed to search orchestration V2 threads.";
  }
}

export interface ThreadSearchQueryShape {
  /**
   * Search active thread user messages and assistant outputs without hydrating
   * thread projections.
   */
  readonly searchThreads: (
    input: OrchestrationSearchThreadsInput,
  ) => Effect.Effect<OrchestrationSearchThreadsResult, ThreadSearchQueryError>;
}

export class ThreadSearchQuery extends Context.Service<ThreadSearchQuery, ThreadSearchQueryShape>()(
  "t3/orchestration-v2/ThreadSearchQuery",
) {}

const ThreadSearchRequest = Schema.Struct({
  pattern: Schema.String,
  limit: Schema.Int,
});

const ThreadSearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});

function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function buildSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= 240) {
    return normalizedText;
  }

  const normalizedQuery = foldAsciiCase(query.replace(/\s+/g, " ").trim());
  const matchIndex = foldAsciiCase(normalizedText).indexOf(normalizedQuery);
  const bodyLength = 236;
  const idealStart = Math.max(0, matchIndex - 72);
  const start = Math.min(idealStart, normalizedText.length - bodyLength);
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

export const layer: Layer.Layer<ThreadSearchQuery, never, SqlClient.SqlClient> = Layer.effect(
  ThreadSearchQuery,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const searchActiveThreadRows = SqlSchema.findAll({
      Request: ThreadSearchRequest,
      Result: ThreadSearchRow,
      execute: ({ pattern, limit }) =>
        sql`
          WITH candidate AS (
            SELECT
              threads.thread_id AS thread_id,
              threads.project_id AS project_id,
              messages.role AS role,
              json_extract(messages.payload_json, '$.text') AS match_text,
              messages.created_at AS message_created_at,
              messages.message_id AS message_id,
              threads.updated_at AS thread_updated_at
            FROM orchestration_v2_projection_messages AS messages
            INNER JOIN orchestration_v2_projection_threads AS threads
              ON threads.thread_id = messages.thread_id
            INNER JOIN projection_projects AS projects
              ON projects.project_id = threads.project_id
            WHERE threads.deleted_at IS NULL
              AND threads.archived_at IS NULL
              AND projects.deleted_at IS NULL
              AND messages.streaming = 0
              AND messages.role IN ('user', 'assistant')
              AND json_extract(messages.payload_json, '$.text') LIKE ${pattern} ESCAPE '!'
          ),
          ranked AS (
            SELECT
              thread_id,
              project_id,
              CASE role
                WHEN 'user' THEN 'user'
                ELSE 'assistant'
              END AS source,
              match_text,
              message_created_at,
              CASE role
                WHEN 'user' THEN 0
                ELSE 1
              END AS match_rank,
              thread_updated_at,
              ROW_NUMBER() OVER (
                PARTITION BY thread_id
                ORDER BY
                  CASE role
                    WHEN 'user' THEN 0
                    ELSE 1
                  END ASC,
                  message_created_at DESC,
                  message_id ASC
              ) AS thread_match_rank
            FROM candidate
          )
          SELECT
            thread_id AS "threadId",
            project_id AS "projectId",
            source,
            match_text AS "matchText",
            message_created_at AS "messageCreatedAt"
          FROM ranked
          WHERE thread_match_rank = 1
          ORDER BY
            match_rank ASC,
            thread_updated_at DESC,
            thread_id ASC
          LIMIT ${limit}
        `,
    });

    const searchThreads: ThreadSearchQueryShape["searchThreads"] = Effect.fn(
      "orchestration-v2.ThreadSearchQuery.searchThreads",
    )(function* (input) {
      const escapedQuery = escapeLikePattern(input.query);
      const rows = yield* searchActiveThreadRows({
        pattern: `%${escapedQuery}%`,
        limit: input.limit ?? 50,
      }).pipe(Effect.mapError((cause) => new ThreadSearchQueryError({ cause })));

      return {
        matches: rows.map((row) => ({
          threadId: row.threadId,
          projectId: row.projectId,
          source: row.source,
          snippet: buildSearchSnippet(row.matchText, input.query),
          messageCreatedAt: row.messageCreatedAt,
        })),
      };
    });

    return { searchThreads } satisfies ThreadSearchQueryShape;
  }),
);
