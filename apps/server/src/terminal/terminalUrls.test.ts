import { describe, expect, it } from "vite-plus/test";

import { createTerminalUrlScanner } from "./terminalUrls.ts";

describe("createTerminalUrlScanner", () => {
  it("finds a coloured URL split across writes", () => {
    const scanner = createTerminalUrlScanner();
    expect(scanner.push("  ➜  Local:   http://localhost:\u001b[1m51")).toEqual([]);
    expect(scanner.push("73\u001b[22m/app/\n")).toEqual(["http://localhost:5173/app/"]);
  });

  it("reads wildcard binds as loopback and ignores non-HTTP ports and remote hosts", () => {
    const scanner = createTerminalUrlScanner();
    expect(
      scanner.push(
        "listening on http://0.0.0.0:8080.\npostgres at http://localhost:5432\nsee https://example.com:443/\n",
      ),
    ).toEqual(["http://localhost:8080/"]);
  });
});
