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
});
