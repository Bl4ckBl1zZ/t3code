import { describe, expect, it } from "vite-plus/test";

import { faviconUrlForOrigin } from "./favicon";

describe("faviconUrlForOrigin", () => {
  it("keys the lookup on the hostname, not the host", () => {
    expect(faviconUrlForOrigin("https://example.com:8443/docs")).toBe(
      "https://www.google.com/s2/favicons?domain=example.com&sz=32",
    );
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:42001",
    "http://[::1]:5173",
    "http://0.0.0.0:8080",
    "http://192.168.1.14:3000",
    "http://10.0.0.7:3000",
    "http://172.20.0.3:3000",
    "http://buildbox.local:3000",
    "http://buildbox:3000",
  ])("returns null for %s, which no public provider can resolve", (url) => {
    expect(faviconUrlForOrigin(url)).toBeNull();
  });

  it.each([null, undefined, "", "not a url", "file:///tmp/index.html"])(
    "returns null for %s",
    (url) => {
      expect(faviconUrlForOrigin(url)).toBeNull();
    },
  );
  it("never sends private origin hostnames to the public provider", () => {
    for (const url of [
      "http://localhost:3000/",
      "http://127.0.0.1:3000/",
      "http://0.0.0.0:3000/",
      "http://devbox:3000/",
      "https://24x.xf.local/",
      "http://printer.home.arpa/",
      "http://192.168.1.20:3000/",
      "http://[::]/",
      "http://[::ffff:192.168.1.20]/",
      "http://100.65.180.100:3000/",
      "https://devbox.example.ts.net/",
      "http://192.0.2.1/",
      "http://198.51.100.1/",
      "http://203.0.113.1/",
      "http://224.0.0.1/",
      "http://240.0.0.1/",
      "http://[2001:db8::1]/",
      "http://[ff02::1]/",
      "http://app.test../",
      "https://24x.xf.local../",
      "http://printer.home.arpa../",
      "https://devbox.example.ts.net../",
      "http://127.0.0.1../",
      "http://127.1../",
      "http://10.1../",
      "http://172.16.1../",
      "http://192.168.1../",
    ]) {
      expect(faviconUrlForOrigin(url)).toBeNull();
    }
    expect(faviconUrlForOrigin("https://example.com/path", 32)).toBe(
      "https://www.google.com/s2/favicons?domain=example.com&sz=32",
    );
  });
});
