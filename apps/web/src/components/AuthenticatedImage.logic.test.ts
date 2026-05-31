import { describe, expect, it } from "vitest";

import { shouldFetchImageWithBearer } from "./AuthenticatedImage.logic";

describe("shouldFetchImageWithBearer", () => {
  it("fetches same-origin image URLs when a bearer token is available", () => {
    expect(
      shouldFetchImageWithBearer({
        src: "http://127.0.0.1:3773/attachments/thread-image-id",
        bearerToken: "sidebar-token",
        currentOrigin: "http://127.0.0.1:3773",
      }),
    ).toBe(true);

    expect(
      shouldFetchImageWithBearer({
        src: "/attachments/thread-image-id",
        bearerToken: "sidebar-token",
        currentOrigin: "http://127.0.0.1:3773",
      }),
    ).toBe(true);
  });

  it("does not fetch without a bearer token or for inline/cross-origin URLs", () => {
    expect(
      shouldFetchImageWithBearer({
        src: "http://127.0.0.1:3773/attachments/thread-image-id",
        bearerToken: null,
        currentOrigin: "http://127.0.0.1:3773",
      }),
    ).toBe(false);

    expect(
      shouldFetchImageWithBearer({
        src: "blob:http://127.0.0.1:3773/image",
        bearerToken: "sidebar-token",
        currentOrigin: "http://127.0.0.1:3773",
      }),
    ).toBe(false);

    expect(
      shouldFetchImageWithBearer({
        src: "https://example.test/image.png",
        bearerToken: "sidebar-token",
        currentOrigin: "http://127.0.0.1:3773",
      }),
    ).toBe(false);
  });
});
