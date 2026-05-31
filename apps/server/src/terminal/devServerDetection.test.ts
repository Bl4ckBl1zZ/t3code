import { describe, expect, it } from "vitest";

import {
  buildLocalHttpUrl,
  collectProcessTreePids,
  listeningPortsToWebServerCandidates,
  normalizeListeningHost,
  parseLsofListeningPorts,
  parsePsPidPpidOutput,
} from "./devServerDetection.ts";

describe("terminal dev server detection helpers", () => {
  it("collects descendants for a terminal process tree", () => {
    const rows = parsePsPidPpidOutput(`
      100 1
      101 100
      102 101
      200 1
    `);

    expect([...collectProcessTreePids(rows, 100)].toSorted()).toEqual([100, 101, 102]);
  });

  it("parses lsof listening ports for allowed process ids", () => {
    const output = `
COMMAND   PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node     101 david   21u  IPv6 0x1111111111111111      0t0  TCP *:3000 (LISTEN)
bun      102 david   14u  IPv4 0x2222222222222222      0t0  TCP 127.0.0.1:5173 (LISTEN)
postgres 999 david   14u  IPv4 0x3333333333333333      0t0  TCP 127.0.0.1:5432 (LISTEN)
    `;

    expect(parseLsofListeningPorts(output, new Set([100, 101, 102]))).toEqual([
      { pid: 101, host: "localhost", port: 3000 },
      { pid: 102, host: "localhost", port: 5173 },
    ]);
  });

  it("normalizes wildcard and loopback hosts to browser-openable URLs", () => {
    expect(normalizeListeningHost("*")).toBe("localhost");
    expect(normalizeListeningHost("[::1]")).toBe("localhost");
    expect(buildLocalHttpUrl("0.0.0.0", 4321)).toBe("http://localhost:4321/");
    expect(listeningPortsToWebServerCandidates([{ pid: 101, host: "::1", port: 3000 }])).toEqual([
      {
        pid: 101,
        host: "localhost",
        port: 3000,
        url: "http://localhost:3000/",
      },
    ]);
  });
});
