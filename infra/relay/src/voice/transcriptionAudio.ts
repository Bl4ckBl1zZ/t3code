/**
 * Byte-level checks on uploaded audio. The relay never decodes audio; it
 * measures the base64 payload and, for WAV, reads the duration from the
 * header so the daily cap does not depend on what the client reports.
 */

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

/** Decoded byte length of a base64 payload, or null when it is not base64. */
export function decodedBase64Length(data: string): number | null {
  if (data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

// Enough for the RIFF header plus metadata chunks some encoders put before "data".
// Apple's recorder pads with a FLLR chunk so "data" starts at byte 4096.
const WAV_HEADER_BASE64_CHARS = 8192;

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/**
 * Seconds of PCM audio in a base64 WAV payload, or null when the header is
 * not a readable PCM WAV. The data size is capped at the bytes actually sent.
 */
export function wavDurationSeconds(data: string, totalBytes: number): number | null {
  let header: Uint8Array;
  try {
    const prefix = atob(data.slice(0, WAV_HEADER_BASE64_CHARS));
    header = Uint8Array.from(prefix, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
  if (header.length < 12 || ascii(header, 0) !== "RIFF" || ascii(header, 8) !== "WAVE") {
    return null;
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  let bytesPerSecond: number | null = null;
  let offset = 12;
  while (offset + 8 <= header.length) {
    const chunkId = ascii(header, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === "fmt ") {
      if (offset + 24 > header.length) return null;
      const channels = view.getUint16(offset + 10, true);
      const sampleRate = view.getUint32(offset + 12, true);
      const bitsPerSample = view.getUint16(offset + 22, true);
      bytesPerSecond = (sampleRate * channels * bitsPerSample) / 8;
    } else if (chunkId === "data") {
      if (!bytesPerSecond) return null;
      const dataBytes = Math.min(chunkSize, Math.max(0, totalBytes - (offset + 8)));
      return dataBytes / bytesPerSecond;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return null;
}
