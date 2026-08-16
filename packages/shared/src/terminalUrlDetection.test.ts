import { describe, expect, it } from "vite-plus/test";

import {
  createTerminalUrlScanner,
  extractOsc8Uris,
  stripAnsiSequences,
  toDetectedUrl,
  trimUrlBoundary,
} from "./terminalUrlDetection.ts";

const ESC = "\u001b";
const BEL = "\u0007";

const scanAll = (chunks: ReadonlyArray<string>): ReadonlyArray<string> => {
  const scanner = createTerminalUrlScanner();
  const urls: Array<string> = [];
  for (const chunk of chunks) {
    for (const detected of scanner.push(chunk)) urls.push(detected.url);
  }
  return urls;
};

const scan = (output: string): ReadonlyArray<string> => scanAll([output]);

/**
 * Real startup banners. Adding support for a new stack should be a fixture
 * here, never a code change — if a framework is not detected, its output is
 * the regression test.
 */
const FRAMEWORK_FIXTURES: ReadonlyArray<{
  readonly name: string;
  readonly output: string;
  readonly expected: ReadonlyArray<string>;
}> = [
  {
    name: "vite (port bolded inside the URL)",
    output: `  VITE v7.0.0  ready in 231 ms\n\n  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m\n  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mNetwork${ESC}[22m: ${ESC}[2muse --host to expose${ESC}[22m\n`,
    expected: ["http://localhost:5173/"],
  },
  {
    name: "vite with a base path",
    output: `  ➜  Local:   http://localhost:5173/my-app/\n`,
    expected: ["http://localhost:5173/my-app/"],
  },
  {
    name: "vite over https",
    output: `  ➜  Local:   https://localhost:5173/\n`,
    expected: ["https://localhost:5173/"],
  },
  {
    name: "next.js",
    output: `   ▲ Next.js 15.0.3\n   - Local:        http://localhost:3000\n   - Network:      http://192.168.1.24:3000\n\n ✓ Ready in 1893ms\n`,
    expected: ["http://localhost:3000/"],
  },
  {
    name: "nuxt",
    output: `  ➜ Local:    http://localhost:3000/\n  ➜ Network:  use --host to expose\n`,
    expected: ["http://localhost:3000/"],
  },
  {
    name: "astro",
    output: `  ${ESC}[32m┃${ESC}[39m Local    ${ESC}[36mhttp://localhost:4321/${ESC}[39m\n  ${ESC}[32m┃${ESC}[39m Network  use --host to expose\n`,
    expected: ["http://localhost:4321/"],
  },
  {
    name: "create-react-app",
    output: `Compiled successfully!\n\nYou can now view app in the browser.\n\n  Local:            http://localhost:3000\n  On Your Network:  http://10.0.0.4:3000\n`,
    expected: ["http://localhost:3000/"],
  },
  {
    name: "storybook",
    output: `╭─────────────────────────────────────────────────╮\n│   Storybook 8.4.2 for react-vite started        │\n│   Local:            http://localhost:6006/      │\n╰─────────────────────────────────────────────────╯\n`,
    expected: ["http://localhost:6006/"],
  },
  {
    name: "rails (announces one server as both ipv4 and ipv6)",
    output: `=> Booting Puma\n* Listening on http://127.0.0.1:3000\n* Listening on http://[::1]:3000\nUse Ctrl-C to stop\n`,
    expected: ["http://127.0.0.1:3000/"],
  },
  {
    name: "django",
    output: `Starting development server at http://127.0.0.1:8000/\nQuit the server with CONTROL-C.\n`,
    expected: ["http://127.0.0.1:8000/"],
  },
  {
    name: "flask (wildcard bind rewritten to localhost)",
    output: ` * Running on http://0.0.0.0:5000\nPress CTRL+C to quit\n`,
    expected: ["http://localhost:5000/"],
  },
  {
    name: "phoenix",
    output: `[info] Access MyAppWeb.Endpoint at http://localhost:4000\n`,
    expected: ["http://localhost:4000/"],
  },
  {
    name: "spring boot",
    output: `2024-01-02 10:00:00.123  INFO 1 --- [main] o.s.b.w.embedded.tomcat.TomcatWebServer  : Tomcat started on port(s): 8080 (http)\nApplication available at http://localhost:8080\n`,
    expected: ["http://localhost:8080/"],
  },
  {
    name: "go net/http",
    output: `2024/01/02 10:00:00 listening at http://localhost:8000\n`,
    expected: ["http://localhost:8000/"],
  },
  {
    name: "dotnet",
    output: `info: Microsoft.Hosting.Lifetime[14]\n      Now listening on: http://localhost:5241\ninfo: Microsoft.Hosting.Lifetime[14]\n      Now listening on: https://localhost:7241\n`,
    expected: ["http://localhost:5241/", "https://localhost:7241/"],
  },
  {
    name: "jupyter (token in the query must survive)",
    output: `    To access the notebook, open this file in a browser:\n        http://localhost:8888/?token=abc123def456\n`,
    expected: ["http://localhost:8888/?token=abc123def456"],
  },
  {
    name: "react native metro",
    output: `Welcome to Metro v0.81.0\nDev server ready. Press Ctrl+C to exit.\nMetro waiting on http://localhost:8081\n`,
    expected: ["http://localhost:8081/"],
  },
  {
    name: "python http.server",
    output: `Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...\n`,
    expected: ["http://localhost:8000/"],
  },
];

describe("framework startup banners", () => {
  for (const fixture of FRAMEWORK_FIXTURES) {
    it(`detects ${fixture.name}`, () => {
      expect(scan(fixture.output)).toEqual(fixture.expected);
    });
  }
});

describe("false positives", () => {
  const NEGATIVE_FIXTURES: ReadonlyArray<{ readonly name: string; readonly output: string }> = [
    {
      name: "documentation links",
      output: `See https://vitejs.dev/guide/ for details.\nRead more at https://nextjs.org/docs\n`,
    },
    {
      name: "npm audit output",
      output: `4 vulnerabilities (2 moderate, 2 high)\nRun \`npm audit fix\` or visit https://github.com/advisories/GHSA-1234\n`,
    },
    {
      name: "telemetry notice",
      output: `Attention: Next.js collects anonymous telemetry.\nhttps://nextjs.org/telemetry\n`,
    },
    {
      name: "stack trace with a source map url",
      output: `    at Object.<anonymous> (https://cdn.example.com/bundle.js:1:99)\n`,
    },
    {
      name: "node inspector port",
      output: `Debugger listening on ws://127.0.0.1:9229/uuid\nFor help, see: http://localhost:9229/json\n`,
    },
    {
      name: "database listeners",
      output: `postgres ready at http://localhost:5432\nredis at http://127.0.0.1:6379\n`,
    },
    {
      name: "non-http protocols",
      output: `postgresql://user@localhost:5555/db\nws://localhost:3000/socket\n`,
    },
  ];

  for (const fixture of NEGATIVE_FIXTURES) {
    it(`ignores ${fixture.name}`, () => {
      expect(scan(fixture.output)).toEqual([]);
    });
  }

  it("survives a large log flood without matching anything", () => {
    const flood = `${"transforming module some/deep/path/file.ts\n".repeat(5000)}`;
    expect(scan(flood)).toEqual([]);
  });
});

describe("chunk boundaries", () => {
  it("detects a URL split across two PTY reads", () => {
    expect(scanAll(["  ➜  Local:   http://local", "host:5173/\n"])).toEqual([
      "http://localhost:5173/",
    ]);
  });

  it("detects a URL split mid-port", () => {
    expect(scanAll(["Local: http://localhost:51", "73/\n"])).toEqual(["http://localhost:5173/"]);
  });

  it("holds a URL until its line completes", () => {
    const scanner = createTerminalUrlScanner();
    expect(scanner.push("Local: http://localhost:5173/")).toEqual([]);
    expect(scanner.push("\n").map((detected) => detected.url)).toEqual(["http://localhost:5173/"]);
  });

  it("bounds the pending buffer when output never breaks", () => {
    const scanner = createTerminalUrlScanner();
    // 40k of unbroken output must not accumulate, then a real URL still lands.
    for (let index = 0; index < 40; index += 1) scanner.push("x".repeat(1000));
    expect(scanner.push(" http://localhost:4000/\n").map((d) => d.url)).toEqual([
      "http://localhost:4000/",
    ]);
  });
});

describe("dedupe and caps", () => {
  it("reports a repeated URL only once", () => {
    const scanner = createTerminalUrlScanner();
    expect(scanner.push("Local: http://localhost:3000\n")).toHaveLength(1);
    expect(scanner.push("Local: http://localhost:3000\n")).toHaveLength(0);
  });

  it("treats the same port on different loopback hosts as one endpoint", () => {
    expect(scan("http://localhost:3000\nhttp://127.0.0.1:3000\n")).toHaveLength(1);
  });

  it("collapses a wildcard bind onto the loopback name", () => {
    expect(scan("http://0.0.0.0:3000\nhttp://localhost:3000\n")).toEqual([
      "http://localhost:3000/",
    ]);
  });

  it("stops after the URL cap", () => {
    const lines = Array.from(
      { length: 20 },
      (_unused, index) => `http://localhost:${4000 + index}/`,
    ).join("\n");
    expect(scan(`${lines}\n`)).toHaveLength(8);
  });

  it("forgets everything on reset", () => {
    const scanner = createTerminalUrlScanner();
    expect(scanner.push("http://localhost:3000\n")).toHaveLength(1);
    scanner.reset();
    expect(scanner.push("http://localhost:3000\n")).toHaveLength(1);
  });
});

describe("stripAnsiSequences", () => {
  it("removes SGR sequences", () => {
    expect(stripAnsiSequences(`${ESC}[36mhttp://x${ESC}[39m`)).toBe("http://x");
  });

  it("removes OSC sequences terminated by BEL", () => {
    expect(stripAnsiSequences(`${ESC}]0;title${BEL}rest`)).toBe("rest");
  });

  it("removes OSC sequences terminated by ST", () => {
    expect(stripAnsiSequences(`${ESC}]0;title${ESC}\\rest`)).toBe("rest");
  });

  it("treats carriage returns as line breaks", () => {
    expect(stripAnsiSequences("a\rb")).toBe("a\nb");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsiSequences("plain http://localhost:1/")).toBe("plain http://localhost:1/");
  });
});

describe("extractOsc8Uris", () => {
  it("reads the uri out of a hyperlink whose label hides it", () => {
    const link = `${ESC}]8;;http://localhost:5173/${BEL}Open app${ESC}]8;;${BEL}`;
    expect(extractOsc8Uris(link)).toEqual(["http://localhost:5173/"]);
  });

  it("detects a hyperlink whose visible text is not a url", () => {
    const link = `${ESC}]8;;http://localhost:4321/${ESC}\\click here${ESC}]8;;${ESC}\\\n`;
    expect(scan(link)).toEqual(["http://localhost:4321/"]);
  });

  it("returns nothing for unterminated sequences", () => {
    expect(extractOsc8Uris(`${ESC}]8;;http://localhost:1/`)).toEqual([]);
  });
});

describe("trimUrlBoundary", () => {
  // The URL regex starts matching at "http", so a wrapping bracket only ever
  // reaches this function as an unbalanced *trailing* character.
  it.each([
    ["http://localhost:3000.", "http://localhost:3000"],
    ["http://localhost:3000,", "http://localhost:3000"],
    ["http://localhost:3000)", "http://localhost:3000"],
    ["http://localhost:3000>", "http://localhost:3000"],
    ["http://localhost:3000/a)", "http://localhost:3000/a"],
    ["http://localhost:3000/wiki/Foo_(bar)", "http://localhost:3000/wiki/Foo_(bar)"],
    ["http://localhost:3000/", "http://localhost:3000/"],
  ])("trims %s", (input, expected) => {
    expect(trimUrlBoundary(input)).toBe(expected);
  });

  it("drops trailing punctuation in a sentence", () => {
    expect(scan("Server ready at http://localhost:3000.\n")).toEqual(["http://localhost:3000/"]);
  });

  it("drops a wrapping parenthesis", () => {
    expect(scan("Ready (http://localhost:3000)\n")).toEqual(["http://localhost:3000/"]);
  });
});

describe("toDetectedUrl", () => {
  it("strips credentials", () => {
    expect(toDetectedUrl("http://user:secret@localhost:3000/")?.url).toBe("http://localhost:3000/");
  });

  it("marks a base path", () => {
    expect(toDetectedUrl("http://localhost:3000/app")?.hasPath).toBe(true);
    expect(toDetectedUrl("http://localhost:3000/")?.hasPath).toBe(false);
  });

  it("marks a query as a path so it is never dropped", () => {
    expect(toDetectedUrl("http://localhost:8888/?token=x")?.hasPath).toBe(true);
  });

  it("keeps the scheme", () => {
    expect(toDetectedUrl("https://localhost:5173/")?.scheme).toBe("https");
  });

  it("rejects non-loopback hosts", () => {
    expect(toDetectedUrl("http://192.168.1.5:3000/")).toBeNull();
    expect(toDetectedUrl("https://example.com/")).toBeNull();
  });

  it("rejects known non-http ports", () => {
    expect(toDetectedUrl("http://localhost:5432/")).toBeNull();
  });
});
