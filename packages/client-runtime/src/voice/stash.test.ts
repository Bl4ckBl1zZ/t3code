import { describe, expect, it } from "vite-plus/test";

import { createVoiceTranscriptStash } from "./stash.ts";

describe("createVoiceTranscriptStash", () => {
  it("stores and takes entries by identity exactly once", () => {
    const stash = createVoiceTranscriptStash({ now: () => 1_000 });
    stash.put("env:thread-a", "Hello world");
    expect(stash.peek("env:thread-a")).toEqual({ text: "Hello world", stashedAt: 1_000 });
    expect(stash.take("env:thread-a")).toEqual({ text: "Hello world", stashedAt: 1_000 });
    expect(stash.take("env:thread-a")).toBeNull();
  });

  it("ignores empty transcripts and unknown identities", () => {
    const stash = createVoiceTranscriptStash();
    stash.put("env:thread-a", "   ");
    expect(stash.take("env:thread-a")).toBeNull();
    expect(stash.take("env:thread-b")).toBeNull();
  });

  it("replaces an existing entry for the same identity", () => {
    const stash = createVoiceTranscriptStash({ now: () => 5 });
    stash.put("id", "first");
    stash.put("id", "second");
    expect(stash.take("id")?.text).toBe("second");
  });

  it("expires entries past the TTL", () => {
    let clock = 0;
    const stash = createVoiceTranscriptStash({ now: () => clock, ttlMs: 100 });
    stash.put("id", "text");
    clock = 101;
    expect(stash.take("id")).toBeNull();
  });
});
