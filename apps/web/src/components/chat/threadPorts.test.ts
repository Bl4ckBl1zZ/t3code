import type { DiscoveredLocalServer, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadPortRows } from "./threadPorts";

const threadId = "thread-ports" as ThreadId;

function server(
  port: number,
  owner: string | null,
  url = `http://localhost:${port}/`,
): DiscoveredLocalServer {
  return {
    host: "localhost",
    port,
    url,
    processName: "node",
    pid: 42,
    terminal: owner === null ? null : { threadId: owner as ThreadId, terminalId: "default" },
  } as DiscoveredLocalServer;
}

describe("threadPortRows", () => {
  it("lists only this thread's servers, at the URL they announced", () => {
    const rows = threadPortRows({
      threadId,
      servers: [
        server(5173, threadId, "http://localhost:5173/app/?token=secret"),
        server(3000, "other-thread"),
        server(8080, null),
      ],
      pinnedUrl: undefined,
    });
    expect(rows.map((row) => [row.label, row.status])).toEqual([["localhost:5173/app", "running"]]);
  });

  it("pins the project's URL first and reports a stopped local server", () => {
    const rows = threadPortRows({
      threadId,
      servers: [server(4000, threadId)],
      pinnedUrl: "http://127.0.0.1:5173",
    });
    expect(rows.map((row) => [row.label, row.status, row.pinned])).toEqual([
      ["127.0.0.1:5173", "stopped", true],
      ["localhost:4000", "running", false],
    ]);
  });

  it("folds the thread's own server into the pinned row on the same port", () => {
    const rows = threadPortRows({
      threadId,
      servers: [server(5173, threadId)],
      pinnedUrl: "http://localhost:5173/",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("running");
  });

  it("keeps a remote origin pinned without claiming it runs", () => {
    const rows = threadPortRows({
      threadId,
      servers: [server(443, threadId)],
      pinnedUrl: "https://staging.example.com/",
    });
    expect(rows[0]).toMatchObject({ label: "staging.example.com", status: "pinned" });
    expect(rows).toHaveLength(2);
  });
});
