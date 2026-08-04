import { assert, describe, it } from "@effect/vitest";

import { resolveProjectFileSchemaUrl } from "./projectFileSchemaUrl.ts";

describe("resolveProjectFileSchemaUrl", () => {
  it("derives the URL from the relay this install talks to", () => {
    assert.equal(
      resolveProjectFileSchemaUrl({ T3CODE_RELAY_URL: "https://relay.example.test" }),
      "https://relay.example.test/schema/t3.json",
    );
  });

  it("prefers an explicit override over the relay", () => {
    assert.equal(
      resolveProjectFileSchemaUrl({
        T3CODE_RELAY_URL: "https://relay.example.test",
        T3CODE_PROJECT_FILE_SCHEMA_URL: "https://mirror.example.test/t3.json",
      }),
      "https://mirror.example.test/t3.json",
    );
  });

  it("ignores a relay URL that is not a secure origin", () => {
    // Matches the relay config's own validation: an http:// or malformed relay
    // is not something we hand to editors as a schema source.
    assert.equal(
      resolveProjectFileSchemaUrl({ T3CODE_RELAY_URL: "http://relay.example.test" }),
      null,
    );
    assert.equal(resolveProjectFileSchemaUrl({ T3CODE_RELAY_URL: "relay.example.test" }), null);
  });

  it("resolves to null when nothing publishes a schema", () => {
    // A local-only install advertises no schema rather than one it does not
    // serve, so `t3.json` is written without a broken `$schema` reference.
    assert.equal(resolveProjectFileSchemaUrl({}), null);
    assert.equal(resolveProjectFileSchemaUrl({ T3CODE_PROJECT_FILE_SCHEMA_URL: "  " }), null);
  });
});
