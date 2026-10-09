import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { serializeAssistantCitation } from "./assistantCitations.ts";
import { searchableMessageSegments, searchablePlanSegments } from "./threadFindText.ts";

const userSegments = (text: string, cwd?: string) =>
  searchableMessageSegments({ role: "user", text, streaming: false }, cwd);

it("excludes review attachments rendered as cards", () => {
  const text = [
    "Before **review**",
    '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="hidden.ts" startIndex="3" endIndex="14" rangeLabel="L4">',
    "Keep **this literal** comment.",
    "```diff",
    "+ hidden patch content",
    "```",
    "</review_comment>",
    "After review",
  ].join("\n");
  expect(userSegments(text)).toEqual(["Before review", "After review"]);
});

it("keeps malformed review tags visible, matching the message renderer", () => {
  const text = "<review_comment>not a valid attachment</review_comment>";
  expect(userSegments(text)).toEqual([text]);
});

it("excludes appended terminal, element, and preview context blocks", () => {
  const terminal =
    "<terminal_context>\n- Terminal 1 line 12:\n  12 | hidden output\n</terminal_context>";
  const element =
    "<element_context>\n- button.primary:\n  <button>hidden markup</button>\n</element_context>";
  const preview =
    "<preview_annotation>\nPreview annotation:\nId: a1\nPage: Home\nComment: hidden note\n</preview_annotation>";
  expect(userSegments(`Fix this\n\n${terminal}\n\n${element}`)).toEqual(["Fix this"]);
  expect(userSegments(`Fix this\n\n${preview}`)).toEqual(["Fix this"]);
});

it("splits prose around inline terminal-context chips", () => {
  const terminal =
    "<terminal_context>\n- Terminal 1 lines 3-4:\n  3 | hidden\n  4 | hidden\n</terminal_context>";
  expect(userSegments(`See @terminal-1:3-4 for the error\n\n${terminal}`)).toEqual([
    "See",
    "for the error",
  ]);
});

it("drops the reply envelope and scheduled-task attribution", () => {
  expect(userSegments('[Replying to: "earlier words"]\nnew words')).toEqual(["new words"]);
  expect(
    searchableMessageSegments({
      role: "user",
      streaming: false,
      createdBy: "agent",
      text: "[Triggered by schedule task: Nightly]\n\nRun the checks",
    }),
  ).toEqual(["Run the checks"]);
});

it("shows raw HTML in user prompts as typed", () => {
  expect(userSegments("<b>bold</b> text")).toEqual(["<b>bold</b> text"]);
});

const assistantSegments = (text: string, cwd?: string) =>
  searchableMessageSegments({ role: "assistant", text, streaming: false }, cwd);

it("searches displayed prose and file-chip labels without hidden paths", () => {
  expect(
    assistantSegments("[important description](/tmp/actual.ts). `/tmp/inline-example.ts:42`"),
  ).toEqual(["important description actual.ts. inline-example.ts · L42"]);
  expect(assistantSegments("[label](src/main.ts#L3C2)", "/workspace/repo")).toEqual([
    "label main.ts · L3:C2",
  ]);
  expect(assistantSegments("[label](src/main.ts#L3C2)")).toEqual(["label"]);
  expect(assistantSegments("[main.ts](/tmp/main.ts)")).toEqual(["main.ts"]);
});

it("includes the same parent suffixes for duplicate filenames as the renderer", () => {
  expect(
    assistantSegments(
      "[first](src/main.ts) and `/workspace/repo/tests/main.ts:2`",
      "/workspace/repo",
    ),
  ).toEqual(["first main.ts · repo/src and main.ts · repo/tests · L2"]);
  expect(
    assistantSegments(
      "[first](src/main.ts) and `/workspace/repo/src/main.ts:2`",
      "/workspace/repo",
    ),
  ).toEqual(["first main.ts and main.ts · L2"]);
});

it("keeps fence paths literal and indexes file-chip labels in user messages", () => {
  expect(assistantSegments("```text\n/tmp/file.ts:42\n```")).toEqual(["/tmp/file.ts:42\n"]);
  expect(userSegments("`/tmp/file.ts:42`")).toEqual(["file.ts · L42"]);
});

it("skips HTML embed sources, which render in a frame", () => {
  expect(assistantSegments("Before\n\n```t3-html\n<p>needle</p>\n```\n\nAfter")).toEqual([
    "Before",
    "After",
  ]);
});

it("indexes nested disclosure summaries and bodies in rendered order", () => {
  expect(
    assistantSegments(
      "<details><summary>Outer</summary><p>first</p><details><summary>Inner</summary><p>second</p></details></details>",
    ),
  ).toEqual(["Outer", "first", "Inner", "second"]);
});

it("uses Insight line breaks without splitting ordinary assistant prose", () => {
  expect(assistantSegments("★ Insight ─────\nfirst line\nsecond line")).toEqual([
    "★ Insight ─────",
    " first line",
    " second line",
  ]);
  expect(assistantSegments("first line\nsecond line")).toEqual(["first line second line"]);
});

it("indexes the empty-response placeholder only when nothing else renders", () => {
  expect(assistantSegments("")).toEqual(["(empty response)"]);
  expect(searchableMessageSegments({ role: "assistant", text: "", streaming: true })).toEqual([]);
});

it("indexes skill labels in prose but leaves links and code literal", () => {
  expect(
    searchableMessageSegments(
      {
        role: "assistant",
        streaming: false,
        text: "Use $test-t3-app now.\n\n`$test-t3-app`\n\n[$test-t3-app](https://example.com)",
      },
      undefined,
      [{ name: "test-t3-app", displayName: "T3 App Testing" }],
    ),
  ).toEqual(["Use T3 App Testing now.", "$test-t3-app", "$test-t3-app"]);
});

it("indexes the citation chip label instead of its link text", () => {
  const citation = {
    version: 1 as const,
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
    text: "cited   needle",
    start: 0,
    end: 14,
    prefix: "",
    suffix: "",
  };
  const text = `Please fix ${serializeAssistantCitation(citation)} thanks`;
  expect(userSegments(text)).toEqual(["Please fix cited needle thanks"]);
  const commented = serializeAssistantCitation({ ...citation, comment: "my note" });
  expect(userSegments(commented)).toEqual(["my note"]);
});

it("indexes the plan title and its displayed body, with skills literal", () => {
  expect(searchablePlanSegments("# Ship it\n\n## Summary\n\n- run $deploy")).toEqual([
    "Ship it",
    "run $deploy",
  ]);
  expect(searchablePlanSegments("- step")).toEqual(["Proposed plan", "step"]);
});
