import { describe, expect, it } from "vite-plus/test";

import { bytesToBase64, encodeMonoWav } from "./wavEncoding";

describe("encodeMonoWav", () => {
  it("writes a 16-bit mono PCM header and clips samples", () => {
    const wav = encodeMonoWav(new Float32Array([0, 1, -1, 2, -2]), 16_000);
    const view = new DataView(wav.buffer);
    const ascii = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));

    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint32(40, true)).toBe(10);
    expect([0, 1, 2, 3, 4].map((index) => view.getInt16(44 + index * 2, true))).toEqual([
      0, 32767, -32768, 32767, -32768,
    ]);
  });
});

describe("bytesToBase64", () => {
  it("round-trips recordings larger than one encoding chunk", () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, index) => index % 251);
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (character) =>
      character.charCodeAt(0),
    );
    expect(decoded).toEqual(bytes);
  });
});
