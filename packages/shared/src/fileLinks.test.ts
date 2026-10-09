import { describe, expect, it } from "vite-plus/test";
import {
  buildFileLinkParentSuffixByPath,
  fileLinkLabel,
  filePathPosition,
  resolvePathLinkTarget,
} from "./fileLinks.ts";

describe("filePathPosition", () => {
  it.each([
    ["src/main.ts", { path: "src/main.ts" }],
    ["src/main.ts:12", { path: "src/main.ts", line: 12 }],
    ["src/main.ts:12:5", { path: "src/main.ts", line: 12, column: 5 }],
  ])("splits %s", (target, expected) => {
    expect(filePathPosition(target)).toEqual(expected);
  });
});

describe("resolvePathLinkTarget", () => {
  it("resolves relative paths against cwd", () => {
    expect(
      resolvePathLinkTarget(
        "src/components/ThreadTerminalDrawer.tsx:42:7",
        "/Users/julius/project",
      ),
    ).toBe("/Users/julius/project/src/components/ThreadTerminalDrawer.tsx:42:7");
  });

  it("keeps absolute paths unchanged", () => {
    expect(
      resolvePathLinkTarget("/Users/julius/project/src/main.ts:12", "/Users/julius/project"),
    ).toBe("/Users/julius/project/src/main.ts:12");
  });

  it("keeps Windows absolute paths with forward slashes unchanged", () => {
    expect(
      resolvePathLinkTarget("C:/Users/julius/project/src/main.ts:12", "C:\\Users\\julius\\project"),
    ).toBe("C:/Users/julius/project/src/main.ts:12");
  });

  it.each([
    ["C:\\Users\\julius\\project", "C:\\Users\\julius\\notes.md:3"],
    ["C:/Users/julius/project", "C:/Users/julius\\notes.md:3"],
  ])("resolves home paths against the Windows cwd %s", (cwd, expected) => {
    expect(resolvePathLinkTarget("~/notes.md:3", cwd)).toBe(expected);
  });
});

describe("fileLinkLabel", () => {
  it("names the file, a disambiguating parent, and the position", () => {
    const suffixes = buildFileLinkParentSuffixByPath([
      "/workspace/repo/src/main.ts",
      "/workspace/repo/tests/main.ts",
    ]);
    expect(
      fileLinkLabel({ path: "/workspace/repo/src/main.ts", line: 3, column: 2 }, suffixes),
    ).toBe("main.ts · repo/src · L3:C2");
    expect(fileLinkLabel({ path: "/tmp/notes/", line: 4 }, new Map())).toBe("notes · L4");
  });
});
