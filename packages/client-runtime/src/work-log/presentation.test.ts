import { describe, expect, it } from "vite-plus/test";

import { liveThoughtLine, summarizeToolGroup, toolGroupAction } from "./presentation.ts";

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

describe("liveThoughtLine", () => {
  it("keeps the first sentence, including a closing quote", () => {
    expect(
      liveThoughtLine(
        'Found the cause: the repo has no commits, so `git worktree add` fails with "invalid reference: main." Now checking the UI.',
      ),
    ).toBe(
      'Found the cause: the repo has no commits, so git worktree add fails with "invalid reference: main."',
    );
  });

  it("does not cut at dots inside file names or long dashes", () => {
    expect(
      liveThoughtLine("I read ThreadLaunchService.ts \u2014 it skips the fetch. Next step."),
    ).toBe("I read ThreadLaunchService.ts \u2014 it skips the fetch.");
  });

  it("uses a bold-only opening line as the whole line", () => {
    expect(
      liveThoughtLine("**Narrowing dispatch files**\n\nI should check the adapter. Then more."),
    ).toBe("Narrowing dispatch files");
    expect(liveThoughtLine("**Narrowing dispatch files**\r\n\r\nI should check the adapter.")).toBe(
      "Narrowing dispatch files",
    );
  });

  it("returns unpunctuated text whole and flattens markdown", () => {
    expect(liveThoughtLine("- Checking [the docs](https://x.dev) for **limits**")).toBe(
      "Checking the docs for limits",
    );
    expect(liveThoughtLine("This is *really* ~~not~~ _fine_ in snake_case_names.")).toBe(
      "This is really not fine in snake_case_names.",
    );
    expect(liveThoughtLine("   ")).toBe("");
  });
});
