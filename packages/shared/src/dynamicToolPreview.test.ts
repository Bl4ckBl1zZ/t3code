import { describe, expect, it } from "vite-plus/test";

import { dynamicToolInputPreview } from "./dynamicToolPreview.ts";

describe("dynamicToolInputPreview", () => {
  it("previews a Read tool call as its file path", () => {
    expect(dynamicToolInputPreview({ file_path: "/repo/src/app.ts" })).toEqual({
      kind: "path",
      value: "/repo/src/app.ts",
    });
  });

  it("previews notebook reads as their notebook path", () => {
    expect(dynamicToolInputPreview({ notebook_path: "/repo/analysis.ipynb" })).toEqual({
      kind: "path",
      value: "/repo/analysis.ipynb",
    });
  });

  it("prefers a search pattern over its scoping path", () => {
    expect(dynamicToolInputPreview({ pattern: "**/*.tsx", path: "/repo/src" })).toEqual({
      kind: "pattern",
      value: "**/*.tsx",
    });
  });

  it("falls back to a bare path argument", () => {
    expect(dynamicToolInputPreview({ path: "/repo/src" })).toEqual({
      kind: "path",
      value: "/repo/src",
    });
  });

  it("ignores empty, non-string, and non-object inputs", () => {
    expect(dynamicToolInputPreview({ file_path: "   " })).toBeNull();
    expect(dynamicToolInputPreview({ file_path: 42 })).toBeNull();
    expect(dynamicToolInputPreview({ query: "hello" })).toBeNull();
    expect(dynamicToolInputPreview("string input")).toBeNull();
    expect(dynamicToolInputPreview(["/repo/src/app.ts"])).toBeNull();
    expect(dynamicToolInputPreview(null)).toBeNull();
    expect(dynamicToolInputPreview(undefined)).toBeNull();
  });
});
