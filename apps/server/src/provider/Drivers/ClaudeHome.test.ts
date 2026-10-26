import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  makeClaudeHomeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("labels spawned Claude requests as T3 Code", () =>
      Effect.gen(function* () {
        for (const inherited of [undefined, "", "cli", "sdk-cli", "sdk-ts"]) {
          for (const homePath of ["", "~/.claude-work"]) {
            const environment = { PATH: "/bin", CLAUDE_CODE_ENTRYPOINT: inherited };
            const resolved = yield* makeClaudeEnvironment({ homePath }, environment);
            expect(resolved.CLAUDE_CODE_ENTRYPOINT).toBe("t3-code");
            expect(resolved.PATH).toBe("/bin");
            expect(environment.CLAUDE_CODE_ENTRYPOINT).toBe(inherited);
          }
        }
      }),
    );

    it.effect("keeps a custom Claude entrypoint and leaves terminal environments alone", () =>
      Effect.gen(function* () {
        const custom = yield* makeClaudeEnvironment(
          { homePath: "" },
          { CLAUDE_CODE_ENTRYPOINT: "custom-client" },
        );
        expect(custom.CLAUDE_CODE_ENTRYPOINT).toBe("custom-client");

        const terminal = yield* makeClaudeHomeEnvironment(
          { homePath: "~/.claude-work" },
          { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" },
        );
        expect(terminal.CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts");
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });
});
