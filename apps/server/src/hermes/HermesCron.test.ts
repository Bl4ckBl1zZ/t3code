import { describe, expect, it } from "vite-plus/test";

import { projectHermesCronCapabilities, projectHermesCronJob } from "./HermesCron.ts";

describe("HermesCron projection", () => {
  it("keeps pinned legacy gateways limited to evidenced operations", () => {
    expect(
      projectHermesCronCapabilities({
        status: "legacy",
        protocol: null,
        inventory: null,
        capabilities: ["cron.read", "cron.manage"],
        reason: "legacy",
      }),
    ).toEqual({
      inventory: true,
      create: true,
      edit: false,
      pause: false,
      resume: false,
      delete: true,
      runNow: false,
    });
  });

  it("enables extension mutations only from advertised granular operations", () => {
    expect(
      projectHermesCronCapabilities({
        status: "supported",
        protocol: { major: 1, minor: 2 },
        inventory: {
          "cron.read": "supported",
          "cron.manage": { operations: ["add", "remove", "update", "pause", "resume", "run"] },
        },
        capabilities: ["cron.read", "cron.manage"],
        reason: "supported",
      }),
    ).toEqual({
      inventory: true,
      create: true,
      edit: true,
      pause: true,
      resume: true,
      delete: true,
      runNow: true,
    });
  });

  it("projects provenance and deterministically deduplicates cron executions", () => {
    const job = projectHermesCronJob(
      "hermes_work",
      "work",
      {
        id: "job-1",
        name: "Daily check",
        schedule: "0 9 * * *",
        prompt: "Check status",
        enabled: true,
        executions: [
          { run_id: "run-1", cursor: 4, status: "complete", started_at: "2026-01-01" },
          { run_id: "run-1", cursor: 4, status: "complete", started_at: "2026-01-01" },
          { status: "failed", started_at: "2026-01-02" },
        ],
      },
      0,
    );

    expect(job.identity).toBe("job-1");
    expect(job.executions).toHaveLength(2);
    expect(job.executions[0]).toMatchObject({
      dedupeKey: "hermes-run:run-1",
      provenance: {
        scheduler: "hermes",
        providerInstanceId: "hermes_work",
        profileKey: "work",
        jobIdentity: "job-1",
        upstreamRunId: "run-1",
        upstreamCursor: 4,
        identityStrength: "upstream",
      },
    });
    expect(job.executions[1]?.dedupeKey).toMatch(/^hermes-derived:/u);
  });

  it("marks jobs without upstream id or name as unaddressable", () => {
    const first = projectHermesCronJob(
      "hermes",
      "default",
      { schedule: "0 0 * * *", prompt: "x" },
      2,
    );
    const second = projectHermesCronJob(
      "hermes",
      "default",
      { schedule: "0 0 * * *", prompt: "x" },
      2,
    );
    expect(first.identityStrength).toBe("missing");
    expect(first.identity).toBe(second.identity);
  });
});
