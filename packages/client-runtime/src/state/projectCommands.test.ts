import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import type * as Crypto from "effect/Crypto";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { createProjectEnvironmentAtoms } from "./projectCommands.ts";

const makeRuntime = () =>
  Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
    EnvironmentRegistry | Crypto.Crypto,
    never
  >;

const files = vi.hoisted(() => ({ contents: "{}", reads: 0 }));

vi.mock("./runtime.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./runtime.ts")>();
  return {
    ...original,
    createEnvironmentRpcQueryAtomFamily: () => {
      const family = Atom.family((_key: string) =>
        Atom.make(() => {
          files.reads += 1;
          return AsyncResult.success({ contents: files.contents });
        }),
      );
      return (target: unknown) => family(JSON.stringify(target));
    },
  };
});

afterEach(() => vi.useRealTimers());

describe("project file refresh", () => {
  it("refreshes external config edits, shares the timer, and stops after unmount", async () => {
    vi.useFakeTimers();
    files.contents = "{}";
    files.reads = 0;
    const projects = createProjectEnvironmentAtoms(makeRuntime());
    const target = {
      environmentId: EnvironmentId.make("remote"),
      input: { cwd: "/repo", relativePath: "t3.json" },
    };
    const atom = projects.readFile(target);
    expect(projects.readFile({ ...target, input: { ...target.input } })).toBe(atom);
    const registry = AtomRegistry.make();
    try {
      const unmount = registry.mount(atom);
      const unmountSecond = registry.mount(atom);
      expect(files.reads).toBe(1);
      files.contents = '{"previewUrl":"http://localhost:3000"}';
      await vi.advanceTimersByTimeAsync(1_500);
      expect(registry.get(atom)).toMatchObject({ value: { contents: files.contents } });
      expect(files.reads).toBe(2);
      unmountSecond();
      files.contents = '{"scripts":[]}';
      await vi.advanceTimersByTimeAsync(1_500);
      expect(registry.get(atom)).toMatchObject({ value: { contents: files.contents } });
      unmount();
      await vi.advanceTimersByTimeAsync(0);
      const readsAfterUnmount = files.reads;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(files.reads).toBe(readsAfterUnmount);
    } finally {
      registry.dispose();
    }
  });

  it("does not poll ordinary workspace files", async () => {
    vi.useFakeTimers();
    files.reads = 0;
    const projects = createProjectEnvironmentAtoms(makeRuntime());
    const registry = AtomRegistry.make();
    try {
      registry.mount(
        projects.readFile({
          environmentId: EnvironmentId.make("remote"),
          input: { cwd: "/repo", relativePath: "README.md" },
        }),
      );
      await vi.advanceTimersByTimeAsync(6_000);
      expect(files.reads).toBe(1);
    } finally {
      registry.dispose();
    }
  });
});
