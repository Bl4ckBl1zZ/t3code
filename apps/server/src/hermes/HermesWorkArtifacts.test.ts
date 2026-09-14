import { describe, expect, it } from "vite-plus/test";
import { collectHermesWorkArtifacts } from "./HermesWorkArtifacts.ts";

const session = { id: "session", title: "Research", last_active: 100 };
describe("Hermes Work artifact provenance", () => {
  it("excludes user uploads and input paths returned by non-producing tools", () => {
    expect(
      collectHermesWorkArtifacts(
        session,
        [
          { role: "user", content: "[Uploaded](/tmp/input.pdf)" },
          {
            role: "tool",
            tool_name: "read_file",
            content: { path: "/tmp/input.pdf", content: "https://example.com" },
          },
        ],
        "research",
      ),
    ).toEqual([]);
  });
  it("collects assistant output and producer results with stable source identity", () => {
    const result = collectHermesWorkArtifacts(
      session,
      [
        {
          role: "assistant",
          timestamp: 90,
          content:
            '![Chart](/tmp/chart.png) [Report](/tmp/report.pdf) MEDIA:"/tmp/with spaces.mp3"',
        },
        {
          role: "tool",
          tool_name: "generate_image",
          content: { image_path: "/tmp/chart.png", output_file: "/tmp/other.png" },
        },
        { role: "tool", tool_name: "read_file", content: { output_path: "/tmp/explicit.pdf" } },
      ],
      "research",
    );
    expect(result.map((item) => item.value)).toEqual([
      "/tmp/with spaces.mp3",
      "/tmp/chart.png",
      "/tmp/report.pdf",
      "/tmp/other.png",
      "/tmp/explicit.pdf",
    ]);
    expect(result.find((item) => item.value === "/tmp/chart.png")).toMatchObject({
      kind: "image",
      sessionId: "session",
      profile: "research",
      timestamp: 90_000,
    });
  });
  it("preserves hyperlinks without accepting script links", () => {
    const result = collectHermesWorkArtifacts(
      session,
      [
        {
          role: "assistant",
          content: "[Source](https://example.com/research) [Bad](javascript:alert)",
        },
      ],
      "research",
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "link", value: "https://example.com/research" });
  });
});
