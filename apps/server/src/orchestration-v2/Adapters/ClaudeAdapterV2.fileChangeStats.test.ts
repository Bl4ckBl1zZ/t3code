/**
 * Fixtures here are trimmed copies of real Claude Agent SDK tool results, so the
 * shapes are the ones the adapter actually receives rather than ones invented to
 * match the parser.
 */
import { describe, expect, it } from "@effect/vitest";

import { claudeFileChangeLineCounts } from "./ClaudeAdapterV2.ts";

const EDIT_RESULT = {
  filePath: "/repo/apps/web/src/main.tsx",
  oldString: "      <div className={shared} title={attachment.name}>",
  newString: "      <div\n        className={shared}\n        title={attachment.name}\n      >",
  structuredPatch: [
    {
      oldStart: 65,
      oldLines: 7,
      newStart: 65,
      newLines: 11,
      lines: [
        "   // ellipsis either.",
        "     return (",
        "-      <div className={shared} title={attachment.name}>",
        "+      <div",
        "+        className={shared}",
        "+        title={attachment.name}",
        "+      >",
        "         {body}",
        "       </div>",
      ],
    },
  ],
  userModified: false,
  replaceAll: false,
};

describe("claudeFileChangeLineCounts", () => {
  it("counts an edit from its structured patch", () => {
    expect(claudeFileChangeLineCounts(EDIT_RESULT)).toEqual({ additions: 4, deletions: 1 });
  });

  it("sums every hunk of a multi-hunk patch", () => {
    expect(
      claudeFileChangeLineCounts({
        structuredPatch: [
          { lines: ["+one", "-two", " ctx"] },
          { lines: ["+three", "+four", "-five"] },
        ],
      }),
    ).toEqual({ additions: 3, deletions: 2 });
  });

  it("counts a created file as its whole contents added", () => {
    // Write produces an empty patch — there is no hunk to describe a new file.
    expect(
      claudeFileChangeLineCounts({
        type: "create",
        filePath: "/repo/new.ts",
        content: "one\ntwo\nthree\n",
        structuredPatch: [],
      }),
    ).toEqual({ additions: 3, deletions: 0 });
  });

  it("does not count a trailing newline as an extra line", () => {
    expect(
      claudeFileChangeLineCounts({ type: "create", content: "only\n", structuredPatch: [] }),
    ).toEqual({ additions: 1, deletions: 0 });
    expect(
      claudeFileChangeLineCounts({ type: "create", content: "only", structuredPatch: [] }),
    ).toEqual({ additions: 1, deletions: 0 });
  });

  it("counts an empty new file as nothing added", () => {
    expect(
      claudeFileChangeLineCounts({ type: "create", content: "", structuredPatch: [] }),
    ).toEqual({ additions: 0, deletions: 0 });
  });

  it("parses a result delivered as a JSON string", () => {
    expect(claudeFileChangeLineCounts(JSON.stringify(EDIT_RESULT))).toEqual({
      additions: 4,
      deletions: 1,
    });
  });

  // Better no diffstat than a wrong one: an unset count renders the row exactly
  // as it did before this existed.
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a plain string", "The file has been updated."],
    ["an object with no patch", { filePath: "/repo/a.ts" }],
    ["a non-array patch", { structuredPatch: "nope" }],
  ])("returns null for %s", (_label, value) => {
    expect(claudeFileChangeLineCounts(value)).toBeNull();
  });

  it("ignores malformed hunks instead of failing the whole count", () => {
    expect(
      claudeFileChangeLineCounts({
        structuredPatch: [null, { lines: "not-an-array" }, { lines: ["+kept", 42] }],
      }),
    ).toEqual({ additions: 1, deletions: 0 });
  });
});
