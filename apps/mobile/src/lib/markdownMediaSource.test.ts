import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

import {
  isMarkdownVideoSource,
  markdownMediaFileName,
  resolveMarkdownMediaSource,
} from "./markdownMediaSource";

const threadId = ThreadId.make("thread-1");

describe("resolveMarkdownMediaSource", () => {
  it("passes through directly loadable sources", () => {
    for (const src of [
      "https://example.com/a.png",
      "data:image/png;base64,AAAA",
      "//cdn.example.com/a.png",
    ]) {
      expect(resolveMarkdownMediaSource(src, threadId)).toEqual({ _tag: "direct", url: src });
    }
  });

  it("routes a Hermes browser artifact to the artifact resource", () => {
    expect(resolveMarkdownMediaSource("/tmp/browser-artifacts/shot.png", threadId)).toEqual({
      _tag: "resource",
      resource: { _tag: "browser-artifact", fileName: "shot.png" },
    });
  });

  it("routes a workspace path to the thread's workspace file", () => {
    expect(resolveMarkdownMediaSource("./out/render.png", threadId)).toEqual({
      _tag: "resource",
      resource: { _tag: "workspace-file", threadId, path: "out/render.png" },
    });
  });

  it("strips the leading slash from an escaped Windows drive path", () => {
    const resolved = resolveMarkdownMediaSource("/C:/work/out.png", threadId);
    expect(resolved._tag).toBe("resource");
    if (resolved._tag === "resource" && resolved.resource._tag === "workspace-file") {
      expect(resolved.resource.path).toBe("C:/work/out.png");
    }
  });

  it("decodes percent-encoded names", () => {
    expect(markdownMediaFileName("./out/my%20render.png")).toBe("my render.png");
  });

  it("detects video sources by extension, ignoring the query", () => {
    expect(isMarkdownVideoSource("./demo.mp4?v=2")).toBe(true);
    expect(isMarkdownVideoSource("./demo.mov")).toBe(true);
    expect(isMarkdownVideoSource("./shot.png")).toBe(false);
  });
});
