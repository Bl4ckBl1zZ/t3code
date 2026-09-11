import { EnvironmentId, type OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { expect, it } from "vite-plus/test";
import { EMPTY_ENVIRONMENT_CATALOG_STATE } from "./connections.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentThreadShellAtoms } from "./threadShell.ts";

it("updates settlement authority when capabilities arrive without replacing the thread snapshot", () => {
  const environmentId = EnvironmentId.make("env");
  const automatic = Atom.make(false);
  const snapshot = Atom.make({
    schemaVersion: 1,
    snapshotSequence: 1,
    projects: [],
    threads: [v2ThreadShell],
    archivedThreads: [],
    updatedAt: v2ThreadShell.updatedAt,
  } as OrchestrationV2ShellSnapshot);
  const atoms = createEnvironmentThreadShellAtoms({
    catalogValueAtom: Atom.make(EMPTY_ENVIRONMENT_CATALOG_STATE),
    snapshotAtom: () => snapshot,
    autoSettlementAtom: () => automatic,
  });
  const registry = AtomRegistry.make();
  const selected = atoms.threadShellAtom({ environmentId, threadId: v2ThreadShell.id });
  const unmount = registry.mount(selected);
  try {
    const legacy = registry.get(selected);
    expect(legacy?.serverAutoSettlement).toBe(false);
    registry.set(automatic, true);
    const authoritative = registry.get(selected);
    expect(authoritative?.serverAutoSettlement).toBe(true);
    expect(authoritative).not.toBe(legacy);
    expect(registry.get(selected)).toBe(authoritative);
    registry.set(automatic, false);
    expect(registry.get(selected)?.serverAutoSettlement).toBe(false);
  } finally {
    unmount();
    registry.dispose();
  }
});
