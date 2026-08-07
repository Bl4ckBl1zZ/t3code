import Foundation

/// Canonical RIFF/WAVE assembly for captured microphone audio.
///
/// Ported from the format decision documented in
/// apps/mobile/src/features/voice/MobileVoiceCapture.ts: transcription
/// providers routinely reject iOS-encoded AAC/m4a with HTTP 400 even though the
/// container is valid, so iOS records 16 kHz mono 16-bit PCM and wraps it in a
/// WAV header written here. This is not a quality choice and must not be
/// "upgraded" to the platform-native encoder.
///
/// At 32 kB/s a full 120 s recording is ~3.8 MB, comfortably inside the 12 MB
/// upload cap even after base64 expansion.
public enum VoiceWaveFile {
    /// 16 kHz is the sample rate speech models are trained at; anything higher
    /// is bytes the transcriber discards.
    public static let sampleRate = 16_000
    public static let channelCount = 1
    public static let bitsPerSample = 16
    /// A canonical WAV header: RIFF (12) + fmt (24) + data (8).
    public static let headerByteCount = 44

    /// Bytes one second of audio occupies in the configured format.
    public static func byteRate(
        sampleRate: Int = sampleRate,
        channelCount: Int = channelCount,
        bitsPerSample: Int = bitsPerSample
    ) -> Int {
        sampleRate * channelCount * bitsPerSample / 8
    }

    public static func durationSeconds(
        dataByteCount: Int,
        sampleRate: Int = sampleRate,
        channelCount: Int = channelCount,
        bitsPerSample: Int = bitsPerSample
    ) -> Double {
        let rate = byteRate(
            sampleRate: sampleRate,
            channelCount: channelCount,
            bitsPerSample: bitsPerSample
        )
        guard rate > 0 else { return 0 }
        return Double(dataByteCount) / Double(rate)
    }

    /// The 44-byte canonical header for `dataByteCount` bytes of PCM samples.
    ///
    /// Every multi-byte field is little-endian, which is what RIFF specifies and
    /// what every decoder assumes regardless of host byte order.
    public static func header(
        dataByteCount: Int,
        sampleRate: Int = sampleRate,
        channelCount: Int = channelCount,
        bitsPerSample: Int = bitsPerSample
    ) -> Data {
        let blockAlign = channelCount * bitsPerSample / 8
        let byteRate = sampleRate * blockAlign
        // `RIFF` counts everything after its own size field: the 44-byte header
        // minus "RIFF" and the size itself, plus the samples.
        let riffChunkSize = UInt32(clamping: headerByteCount - 8 + max(0, dataByteCount))

        var header = Data(capacity: headerByteCount)
        header.append(ascii: "RIFF")
        header.append(littleEndian: riffChunkSize)
        header.append(ascii: "WAVE")
        header.append(ascii: "fmt ")
        header.append(littleEndian: UInt32(16)) // PCM fmt chunk size
        header.append(littleEndian: UInt16(1)) // WAVE_FORMAT_PCM
        header.append(littleEndian: UInt16(clamping: channelCount))
        header.append(littleEndian: UInt32(clamping: sampleRate))
        header.append(littleEndian: UInt32(clamping: byteRate))
        header.append(littleEndian: UInt16(clamping: blockAlign))
        header.append(littleEndian: UInt16(clamping: bitsPerSample))
        header.append(ascii: "data")
        header.append(littleEndian: UInt32(clamping: max(0, dataByteCount)))
        return header
    }

    /// A complete `.wav` file for already-interleaved PCM samples.
    public static func file(
        samples: Data,
        sampleRate: Int = sampleRate,
        channelCount: Int = channelCount,
        bitsPerSample: Int = bitsPerSample
    ) -> Data {
        var file = header(
            dataByteCount: samples.count,
            sampleRate: sampleRate,
            channelCount: channelCount,
            bitsPerSample: bitsPerSample
        )
        file.append(samples)
        return file
    }
}

private extension Data {
    mutating func append(ascii value: String) {
        append(contentsOf: value.utf8)
    }

    mutating func append(littleEndian value: UInt16) {
        append(contentsOf: [UInt8(value & 0xFF), UInt8((value >> 8) & 0xFF)])
    }

    mutating func append(littleEndian value: UInt32) {
        append(contentsOf: [
            UInt8(value & 0xFF),
            UInt8((value >> 8) & 0xFF),
            UInt8((value >> 16) & 0xFF),
            UInt8((value >> 24) & 0xFF),
        ])
    }
}
