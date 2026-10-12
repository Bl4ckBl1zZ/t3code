import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Upstream ships this as 061_PullRequestReviewGuides; the fork owns 036+ for its own schema, so it
 * lands here under the same name and the same idempotent DDL.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The latest guide per pull request, keyed by its host-level identity so every project that
  // checks out the same repository shares one. Guides cost a model run, so a push leaves the old
  // one in place for the page to call stale rather than deleting it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_review_guides (
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL,
      guide_json TEXT NOT NULL,
      PRIMARY KEY (host, repository, number)
    ) WITHOUT ROWID
  `;
});
