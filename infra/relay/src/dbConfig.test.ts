import { describe, expect, it } from "vite-plus/test";

import {
  existingRelayHyperdriveBinding,
  parseRelayDatabaseUrl,
  RelayDatabaseUrlError,
} from "./dbConfig.ts";

describe("parseRelayDatabaseUrl", () => {
  it("parses a complete PostgreSQL URL", () => {
    expect(
      parseRelayDatabaseUrl(
        "postgresql://relay%20user:p%40ssword@db.example.com:15432/t3coderelay?sslmode=require",
      ),
    ).toEqual({
      scheme: "postgresql",
      host: "db.example.com",
      port: 15432,
      database: "t3coderelay",
      user: "relay user",
      password: "p@ssword",
    });
  });

  it("defaults to the PostgreSQL port", () => {
    expect(parseRelayDatabaseUrl("postgres://relay:secret@db.example.com/t3coderelay").port).toBe(
      5432,
    );
  });

  it.each([
    "https://relay:secret@db.example.com/t3coderelay",
    "postgresql://db.example.com/t3coderelay",
    "postgresql://relay:secret@db.example.com/",
    "postgresql://relay:secret@db.example.com/one/two",
    "not a url",
  ])("rejects invalid database URLs: %s", (value) => {
    expect(() => parseRelayDatabaseUrl(value)).toThrow(RelayDatabaseUrlError);
  });

  it("describes an existing Workers VPC Hyperdrive binding", () => {
    const connection = parseRelayDatabaseUrl(
      "postgresql://relay:secret@db.internal:5432/t3coderelay",
    );

    expect(existingRelayHyperdriveBinding("hyperdrive-id", connection)).toEqual({
      hyperdriveId: "hyperdrive-id",
      devOrigin: {
        scheme: "postgresql",
        host: "db.internal",
        port: 5432,
        database: "t3coderelay",
        user: "relay",
        password: "secret",
        sslmode: "require",
      },
    });
  });
});
