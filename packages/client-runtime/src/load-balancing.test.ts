import { describe, expect, it } from "vite-plus/test";
import { chooseLoadBalancedEnvironment } from "./load-balancing.ts";

const now = 100_000;
const resources = {
  sampledAt: now,
  cpuUtilization: 0.2,
  cpuCount: 8,
  availableMemoryBytes: 8_000,
  totalMemoryBytes: 16_000,
};
describe("automatic machine selection", () => {
  it("combines free capacity and the user's machine preference", () => {
    const candidates = [
      { environmentId: "busy", resources: { ...resources, cpuUtilization: 0.9 }, weight: 50 },
      { environmentId: "idle", resources, weight: 50 },
      { environmentId: "preferred", resources: { ...resources, cpuCount: 4 }, weight: 150 },
    ];
    expect(chooseLoadBalancedEnvironment(candidates, now)).toBe("preferred");
    expect(chooseLoadBalancedEnvironment(candidates.slice(0, 2), now)).toBe("idle");
  });
  it("rejects unknown, saturated, excluded and expired samples", () => {
    expect(
      chooseLoadBalancedEnvironment(
        [
          {
            environmentId: "old",
            resources: { ...resources, sampledAt: now - 15_001 },
            weight: 50,
          },
          { environmentId: "missing", resources: null, weight: 50 },
          { environmentId: "cold", resources: { ...resources, cpuUtilization: null }, weight: 50 },
          { environmentId: "manual", resources, weight: 0 },
          {
            environmentId: "cpu-full",
            resources: { ...resources, cpuUtilization: 0.95 },
            weight: 50,
          },
          {
            environmentId: "memory-full",
            resources: { ...resources, availableMemoryBytes: 100 },
            weight: 50,
          },
        ],
        now,
      ),
    ).toBeNull();
  });
  it("uses client receipt time across machines with different clocks", () => {
    const candidate = {
      environmentId: "clock-skew",
      resources: { ...resources, sampledAt: now + 60_000 },
      receivedAt: now,
      weight: 50,
    };
    expect(chooseLoadBalancedEnvironment([candidate], now)).toBe("clock-skew");
    expect(chooseLoadBalancedEnvironment([candidate], now + 15_001)).toBeNull();
  });
});
