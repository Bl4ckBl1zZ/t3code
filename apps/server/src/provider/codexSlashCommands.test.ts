import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  CODEX_BUILT_IN_SLASH_COMMANDS,
  listCodexSlashCommands,
  parseCodexPromptMetadata,
} from "./codexSlashCommands.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const writeTextFile = Effect.fn("codexSlashCommands.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

it.layer(NodeServices.layer)("codexSlashCommands", (it) => {
  describe("parseCodexPromptMetadata", () => {
    it("reads supported prompt frontmatter fields", () => {
      expect(
        parseCodexPromptMetadata(`---
description: "Prepare a clean commit"
argument-hint: MESSAGE
ignored: value
---
Body
`),
      ).toEqual({
        description: "Prepare a clean commit",
        argumentHint: "MESSAGE",
      });
    });

    it("ignores markdown without frontmatter", () => {
      expect(parseCodexPromptMetadata("# Prompt\n")).toEqual({});
    });
  });

  describe("listCodexSlashCommands", () => {
    it.effect("includes documented Codex built-in commands", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-codex-home-",
        });

        const commands = yield* listCodexSlashCommands({
          codexSettings: decodeCodexSettings({ homePath }),
        });
        const commandNames = new Set(commands.map((command) => command.name));

        expect(commandNames.has("permissions")).toBe(true);
        expect(commandNames.has("model")).toBe(true);
        expect(commandNames.has("theme")).toBe(true);
        expect(commands.length).toBe(CODEX_BUILT_IN_SLASH_COMMANDS.length);
      }),
    );

    it.effect("adds custom prompts from the shared Codex home and active project", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-codex-prompts-",
        });
        const homePath = path.join(root, "home");
        const cwd = path.join(root, "project");

        yield* writeTextFile(
          path.join(homePath, "prompts", "commit.md"),
          `---
description: Create a commit message
argument-hint: MESSAGE
---
Summarize the current diff.
`,
        );
        yield* writeTextFile(
          path.join(cwd, ".codex", "prompts", "review.markdown"),
          `---
description: Review this project
argument-hint: TARGET
---
Review the requested target.
`,
        );
        yield* writeTextFile(path.join(homePath, "prompts", "ignored.txt"), "not markdown");

        const commands = yield* listCodexSlashCommands({
          codexSettings: decodeCodexSettings({ homePath }),
          cwd,
        });
        const byName = new Map(commands.map((command) => [command.name, command]));

        expect(byName.get("prompts:commit")).toEqual({
          name: "prompts:commit",
          description: "Create a commit message",
          input: { hint: "MESSAGE" },
        });
        expect(byName.get("prompts:review")).toEqual({
          name: "prompts:review",
          description: "Review this project",
          input: { hint: "TARGET" },
        });
        expect(byName.has("prompts:ignored")).toBe(false);
      }),
    );
  });
});
