import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { EnvironmentPresentation } from "../connection/presentation.ts";
import { refreshUsage } from "./usage.ts";

const input = {
  sinceDay: UsageDay.make("2026-09-05"),
  untilDay: UsageDay.make("2026-09-05"),
  timeZone: "UTC",
};
const summary: UsageSummary = {
  ...input,
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-09-05T12:00:00Z",
  buckets: [],
  sources: [],
  pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 1,
};
const registries: AtomRegistry.AtomRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

function harness(ids = ["a"]) {
  const registry = AtomRegistry.make();
  registries.push(registry);
  const environments = ids.map((id) => {
    const environmentId = EnvironmentId.make(id);
    const scan = Promise.withResolvers<UsageSummary>();
    const started = Promise.withResolvers<void>();
    const presentation = Atom.make({
      connection: { phase: "connected" },
    } as EnvironmentPresentation | null);
    const query = Atom.make(
      Effect.promise(() => {
        started.resolve();
        return scan.promise;
      }),
    );
    return { environmentId, scan, started, presentation, query };
  });
  const get = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)!;
  const options = {
    registry,
    environmentIds: environments.map((entry) => entry.environmentId),
    input,
    server: {
      usageSummary: ({ environmentId }: { environmentId: EnvironmentId }) =>
        get(environmentId).query,
    },
    presentations: { presentationAtom: (id: EnvironmentId) => get(id).presentation },
  } satisfies Parameters<typeof refreshUsage>[0];
  return { registry, environments, refresh: () => refreshUsage(options) };
}

describe("manual usage refresh", () => {
  it("stays pending until the requested rescan completes", async () => {
    const {
      environments: [entry],
      refresh,
    } = harness();
    let finished = false;
    const task = refresh().then(() => {
      finished = true;
    });
    await entry!.started.promise;
    expect(finished).toBe(false);
    entry!.scan.resolve(summary);
    await task;
    expect(finished).toBe(true);
  });
  it("stops waiting when a machine disconnects during its scan", async () => {
    const {
      registry,
      environments: [entry],
      refresh,
    } = harness();
    const task = refresh();
    await entry!.started.promise;
    registry.set(entry!.presentation, null);
    await task;
  });
  it("waits for healthy machines without hanging on an offline machine", async () => {
    const {
      registry,
      environments: [healthy, offline],
      refresh,
    } = harness(["healthy", "offline"]);
    registry.set(offline!.presentation, null);
    let finished = false;
    const task = refresh().then(() => {
      finished = true;
    });
    await healthy!.started.promise;
    expect(finished).toBe(false);
    healthy!.scan.resolve(summary);
    await task;
    expect(finished).toBe(true);
  });
  it("replaces a scan that started before the manual refresh", async () => {
    const {
      registry,
      environments: [entry],
      refresh,
    } = harness();
    let reads = 0;
    const rescanned = Promise.withResolvers<void>();
    entry!.query = Atom.make(
      Effect.promise(() => {
        reads += 1;
        if (reads > 1) {
          rescanned.resolve();
          return Promise.resolve(summary);
        }
        return new Promise<UsageSummary>(() => {});
      }),
    );
    const unmount = registry.mount(entry!.query);
    expect(reads).toBe(1);
    const task = refresh();
    await rescanned.promise;
    await task;
    expect(reads).toBe(2);
    unmount();
  });
});
