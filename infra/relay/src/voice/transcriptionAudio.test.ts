import { describe, expect, it } from "@effect/vitest";

import { wavDurationSeconds } from "./transcriptionAudio.ts";

/** A 16 kHz mono 16-bit WAV laid out like iOS's AVAudioRecorder writes it. */
function appleWav(seconds: number): { data: string; bytes: number } {
  const dataOffset = 4096;
  const dataBytes = seconds * 16_000 * 2;
  const bytes = new Uint8Array(dataOffset + dataBytes);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((character, index) => (bytes[offset + index] = character.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "FLLR");
  view.setUint32(40, dataOffset - 8 - 44, true);
  text(dataOffset - 8, "data");
  view.setUint32(dataOffset - 4, dataBytes, true);
  return { data: Buffer.from(bytes).toString("base64"), bytes: bytes.length };
}

describe("wavDurationSeconds", () => {
  it("reads iOS recordings whose data chunk starts after FLLR padding", () => {
    const { data, bytes } = appleWav(2);
    expect(wavDurationSeconds(data, bytes)).toBe(2);
  });
});
