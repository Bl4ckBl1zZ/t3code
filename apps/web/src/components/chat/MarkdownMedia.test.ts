import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownMediaSource } from "./MarkdownMedia";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("resolveMarkdownMediaSource", () => {
  it("uses exact host-file access only when the target server advertises document previews", () => {
    expect(resolveMarkdownMediaSource("/tmp/plot.png", threadRef, undefined, true)).toMatchObject({
      resource: { _tag: "media-file", path: "/tmp/plot.png" },
    });
    expect(resolveMarkdownMediaSource("/tmp/plot.png", threadRef, undefined, false)).toMatchObject({
      resource: { _tag: "workspace-file" },
    });
    expect(resolveMarkdownMediaSource("../plot.png", threadRef, "/repo/docs", true)).toMatchObject({
      resource: { _tag: "media-file", path: "/repo/docs/../plot.png" },
    });
    expect(
      resolveMarkdownMediaSource("https://example.com/plot.png", threadRef, undefined, true),
    ).toEqual({ _tag: "direct", url: "https://example.com/plot.png" });
    expect(
      resolveMarkdownMediaSource("/tmp/browser-artifacts/plot.png", threadRef, undefined, true),
    ).toMatchObject({ resource: { _tag: "browser-artifact" } });
  });
  it("keeps browser-loadable media URLs direct", () => {
    expect(resolveMarkdownMediaSource("//cdn.example.test/demo.mp4", threadRef)).toEqual({
      _tag: "direct",
      url: "//cdn.example.test/demo.mp4",
    });
  });

  it("resolves workspace media after decoding and removing query strings", () => {
    expect(resolveMarkdownMediaSource("./recordings/demo%20run.mp4?download=1", threadRef)).toEqual(
      {
        _tag: "resource",
        resource: {
          _tag: "workspace-file",
          threadId: threadRef.threadId,
          path: "recordings/demo run.mp4",
        },
      },
    );
  });

  it("recognizes only absolute browser-artifact paths", () => {
    expect(
      resolveMarkdownMediaSource(
        "/tmp/userdata/browser-artifacts/browser-recording-demo.webm",
        threadRef,
      ),
    ).toEqual({
      _tag: "resource",
      resource: {
        _tag: "browser-artifact",
        fileName: "browser-recording-demo.webm",
      },
    });
    expect(
      resolveMarkdownMediaSource("docs/browser-artifacts/browser-recording-demo.webm", threadRef),
    ).toMatchObject({
      resource: {
        _tag: "workspace-file",
        path: "docs/browser-artifacts/browser-recording-demo.webm",
      },
    });
  });

  it("resolves rendered-file images from the containing folder, preserving direct URLs", () => {
    expect(resolveMarkdownMediaSource("images/plot.png", threadRef, "/repo/docs")).toMatchObject({
      resource: { path: "/repo/docs/images/plot.png" },
    });
    expect(
      resolveMarkdownMediaSource("https://example.com/plot.png", threadRef, "/repo/docs"),
    ).toEqual({ _tag: "direct", url: "https://example.com/plot.png" });
  });

  it("unescapes sanitized Windows drive paths", () => {
    expect(
      resolveMarkdownMediaSource(
        "/C:\\Users\\me\\browser-artifacts\\browser-screenshot-demo.png",
        threadRef,
      ),
    ).toMatchObject({
      resource: {
        _tag: "browser-artifact",
        fileName: "browser-screenshot-demo.png",
      },
    });
  });
});
