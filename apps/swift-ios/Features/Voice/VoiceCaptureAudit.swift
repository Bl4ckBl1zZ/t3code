import Foundation

/// What the assembled PCM actually contains, measured before anything is
/// uploaded.
///
/// Exists because a silent recording is not an error anywhere in the stack: the
/// engine runs, the tap fires, the converter emits frames, the WAV assembles,
/// the relay accepts it, and the transcriber returns an empty string. The
/// cleanup pass is then handed that empty string and answers conversationally —
/// which is how "Please provide the audio file or the content you would like
/// transcribed" ended up in a user's composer as if it were their own dictation.
///
/// Cheap to compute (one pass over samples the sink has already touched) and
/// pure, so the thresholds are testable without a microphone.
public struct VoiceCaptureAudit: Sendable, Equatable {
    /// Peak amplitude, in Int16 units, at or below which the recording carries
    /// no signal a transcriber could use. 32/32768 is -60 dBFS: a live
    /// microphone in a silent room still floats well above this on its own noise
    /// floor, while a muted or unrouted input sits at or near zero, so the two
    /// cases are separated by tens of decibels rather than by a hair.
    public static let silenceFloorAmplitude = 32
    /// Shorter than this cannot contain a word. The gesture machine already
    /// discards holds under 500 ms from press and only starts recording at
    /// 300 ms, so a legitimate hold clears this comfortably; it catches the
    /// releases that land while the engine is still spinning up.
    public static let minimumDurationSeconds = 0.12
    /// Not a rejection — a flag for the diagnostics log. Real handheld speech
    /// peaks far above -40 dBFS; sitting under it for a whole recording means
    /// the input route is attenuating everything, which is worth seeing even
    /// when the audio is technically usable.
    public static let quietPeakDecibels = -40.0

    public let byteCount: Int
    public let frameCount: Int
    /// 0...32768.
    public let peakAmplitude: Int
    /// 0...1.
    public let rootMeanSquare: Double
    /// Frames that are exactly zero. An all-zero recording is the signature of
    /// an engine that ran without ever being handed the microphone.
    public let zeroFrameCount: Int

    public init(
        byteCount: Int,
        frameCount: Int,
        peakAmplitude: Int,
        rootMeanSquare: Double,
        zeroFrameCount: Int
    ) {
        self.byteCount = byteCount
        self.frameCount = frameCount
        self.peakAmplitude = peakAmplitude
        self.rootMeanSquare = rootMeanSquare
        self.zeroFrameCount = zeroFrameCount
    }

    public var durationSeconds: Double {
        VoiceWaveFile.durationSeconds(dataByteCount: byteCount)
    }

    public var peakDecibels: Double {
        decibels(Double(peakAmplitude) / 32_768)
    }

    public var rootMeanSquareDecibels: Double {
        decibels(rootMeanSquare)
    }

    /// Every frame is exactly zero: not quiet, but nothing at all.
    public var isDigitalSilence: Bool {
        frameCount > 0 && zeroFrameCount == frameCount
    }

    public var isQuiet: Bool {
        frameCount > 0 && peakDecibels < Self.quietPeakDecibels
    }

    /// Why this recording must not be uploaded, or `nil` when it may be.
    ///
    /// Ordered from most to least specific so the message the user sees names
    /// the thing they can act on.
    public var rejection: VoiceCaptureError? {
        if frameCount == 0 { return .noAudioCaptured }
        if durationSeconds < Self.minimumDurationSeconds { return .recordingTooShort }
        if peakAmplitude <= Self.silenceFloorAmplitude { return .silentInput }
        return nil
    }

    private func decibels(_ amplitude: Double) -> Double {
        amplitude > 0 ? 20 * log10(amplitude) : -.infinity
    }

    /// Measures interleaved little-endian 16-bit PCM — the exact bytes
    /// `VoiceWaveFile.file(samples:)` is about to wrap.
    ///
    /// A trailing odd byte cannot be a frame and is ignored rather than read
    /// past.
    public static func audit(samples: Data) -> VoiceCaptureAudit {
        let frameCount = samples.count / 2
        guard frameCount > 0 else {
            return VoiceCaptureAudit(
                byteCount: samples.count,
                frameCount: 0,
                peakAmplitude: 0,
                rootMeanSquare: 0,
                zeroFrameCount: 0
            )
        }

        var peak = 0
        var zeros = 0
        var sumOfSquares = 0.0
        samples.withUnsafeBytes { raw in
            // Deliberately byte-wise rather than a rebind to Int16: `Data` makes
            // no alignment promise, and the WAV payload is little-endian by
            // definition regardless of host order.
            for index in 0..<frameCount {
                let low = Int(raw[index * 2])
                let high = Int(raw[index * 2 + 1])
                let unsigned = low | (high << 8)
                let sample = unsigned >= 0x8000 ? unsigned - 0x1_0000 : unsigned
                if sample == 0 { zeros += 1 }
                let magnitude = sample == Int(Int16.min) ? 32_768 : abs(sample)
                if magnitude > peak { peak = magnitude }
                let normalized = Double(sample) / 32_768
                sumOfSquares += normalized * normalized
            }
        }

        return VoiceCaptureAudit(
            byteCount: samples.count,
            frameCount: frameCount,
            peakAmplitude: peak,
            rootMeanSquare: (sumOfSquares / Double(frameCount)).squareRoot(),
            zeroFrameCount: zeros
        )
    }
}

extension VoiceCaptureAudit: CustomStringConvertible {
    public var description: String {
        let peak = peakDecibels.isFinite ? String(format: "%.1f", peakDecibels) : "-inf"
        let rms = rootMeanSquareDecibels.isFinite
            ? String(format: "%.1f", rootMeanSquareDecibels)
            : "-inf"
        return """
        bytes=\(byteCount) frames=\(frameCount) \
        duration=\(String(format: "%.3f", durationSeconds))s \
        peak=\(peakAmplitude) (\(peak) dBFS) rms=\(rms) dBFS \
        zeroFrames=\(zeroFrameCount) \
        digitalSilence=\(isDigitalSilence) quiet=\(isQuiet)
        """
    }
}
