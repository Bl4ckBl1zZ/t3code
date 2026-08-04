import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildT3ProjectFileJsonSchema,
  T3ProjectFileFromJson,
  t3ProjectFileSchemaUrl,
} from "./t3ProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(T3ProjectFileFromJson);

describe("buildT3ProjectFileJsonSchema", () => {
  it("emits a draft 2020-12 schema", () => {
    const schema = buildT3ProjectFileJsonSchema();

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("stamps the serving deployment's $id, and none when it is not given one", () => {
    // The $id must name a URL that serves *this* build's document: it declares
    // additionalProperties: false, so a mismatched copy rejects real fields.
    // The relay passes the request it is answering; nothing is hardcoded.
    expect(
      buildT3ProjectFileJsonSchema({ id: "https://relay.example.test/schema/t3.json" }).$id,
    ).toBe("https://relay.example.test/schema/t3.json");
    expect(buildT3ProjectFileJsonSchema().$id).toBeUndefined();
    expect(buildT3ProjectFileJsonSchema({ id: null }).$id).toBeUndefined();
  });

  it("documents every supported field", () => {
    const schema = buildT3ProjectFileJsonSchema() as {
      properties: Record<
        string,
        {
          description?: string;
          items?: { properties: Record<string, unknown>; required: ReadonlyArray<string> };
        }
      >;
      required?: ReadonlyArray<string>;
    };

    expect(Object.keys(schema.properties).sort()).toEqual([
      "$schema",
      "iconPath",
      "previewUrl",
      "scripts",
    ]);
    expect(schema.required).toBeUndefined();
    expect(schema.properties.iconPath?.description).toContain("Workspace-relative path");
    expect(schema.properties.previewUrl?.description).toContain("Ports section");

    const script = schema.properties.scripts?.items;
    expect(script?.required).toEqual(["name", "command"]);
    expect(Object.keys(script?.properties ?? {}).sort()).toEqual([
      "autoOpenPreview",
      "command",
      "icon",
      "name",
      "previewUrl",
      "runOnWorktreeCreate",
      "runOnWorktreeDelete",
      "singleRun",
    ]);
  });

  it("stays JSON-serializable", () => {
    const schema = buildT3ProjectFileJsonSchema();
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });
});

describe("t3ProjectFileSchemaUrl", () => {
  it("resolves against the relay that serves the document", () => {
    expect(t3ProjectFileSchemaUrl("https://relay.example.test")).toBe(
      "https://relay.example.test/schema/t3.json",
    );
    // Relay URLs are normalized with a trailing slash elsewhere; both shapes
    // must land on the same address, not `/schema/schema/t3.json`.
    expect(t3ProjectFileSchemaUrl("https://relay.example.test/")).toBe(
      "https://relay.example.test/schema/t3.json",
    );
  });

  it("returns null for a relay URL it cannot resolve against", () => {
    expect(t3ProjectFileSchemaUrl("")).toBeNull();
    expect(t3ProjectFileSchemaUrl("relay.example.test")).toBeNull();
  });
});

describe("T3ProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });

  it("fails on malformed JSON", () => {
    expect(() => decodeJson("{ not json")).toThrow();
  });
});
