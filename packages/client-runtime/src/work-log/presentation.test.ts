import { describe, expect, it } from "vite-plus/test";

import { summarizeToolGroup, toolGroupAction } from "./presentation.ts";

describe("toolGroupAction", () => {
  const tool = (toolTitle: string) =>
    ({ label: toolTitle, toolTitle, tone: "tool", itemType: "dynamic_tool_call" }) as const;

  it("groups provider read and search tools by what they did", () => {
    expect(toolGroupAction(tool("Read"))).toBe("read");
    expect(toolGroupAction(tool("Read File"))).toBe("read");
    expect(toolGroupAction(tool("Grep"))).toBe("code-search");
    expect(toolGroupAction(tool("Glob"))).toBe("code-search");
    expect(toolGroupAction(tool("mcp__github__search"))).toBe("other");
  });

  it("summarizes mixed reads and searches", () => {
    expect(summarizeToolGroup([tool("Read"), tool("Grep"), tool("Grep")])).toBe(
      "Read 1 file and searched code 2 times",
    );
  });
});
