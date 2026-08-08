import Foundation
import XCTest

@testable import T3Code

/// The guard that stands between a silent microphone and the composer.
///
/// Without it the pipeline has no failure at all for "the engine ran but the mic
/// gave us nothing": the WAV assembles, the relay accepts it, the transcriber
/// returns an empty string, and the cleanup pass answers that empty string
/// conversationally — which is how a model's "Please provide the audio file or
/// the content you would like transcribed" was inserted into a draft as if the
/// user had said it.
final class VoiceCaptureAuditTests: XCTestCase {
    // MARK: - Measurement

    func testAnEmptyPayloadMeasuresAsNothing() {
        let audit = VoiceCaptureAudit.audit(samples: Data())

        XCTAssertEqual(audit.frameCount, 0)
        XCTAssertEqual(audit.byteCount, 0)
        XCTAssertEqual(audit.peakAmplitude, 0)
        XCTAssertEqual(audit.durationSeconds, 0)
        XCTAssertFalse(audit.isDigitalSilence)
    }

    /// The payload is little-endian by definition — it is the WAV's own byte
    /// order — so the reader must not inherit the host's.
    func testSamplesAreReadAsLittleEndianSignedFrames() {
        let audit = VoiceCaptureAudit.audit(
            samples: Data([0xFF, 0xFF, 0x00, 0x80, 0xFF, 0x7F, 0x00, 0x00])
        )

        XCTAssertEqual(audit.frameCount, 4)
        // -1, Int16.min, Int16.max, 0
        XCTAssertEqual(audit.peakAmplitude, 32_768)
        XCTAssertEqual(audit.zeroFrameCount, 1)
    }

    /// A trailing odd byte cannot be a frame; it is ignored rather than read
    /// past the end of the buffer.
    func testATrailingOddByteIsIgnored() {
        var samples = pcm(frames: 100, amplitude: 5_000)
        samples.append(0x7F)

        let audit = VoiceCaptureAudit.audit(samples: samples)

        XCTAssertEqual(audit.byteCount, 201)
        XCTAssertEqual(audit.frameCount, 100)
    }

    func testFullScaleReadsAsZeroDecibels() {
        let audit = VoiceCaptureAudit.audit(samples: pcm(frames: 4_000, amplitude: 32_767))

        XCTAssertEqual(audit.peakDecibels, 0, accuracy: 0.001)
        XCTAssertEqual(audit.rootMeanSquareDecibels, 0, accuracy: 0.001)
    }

    func testHalfScaleReadsAsSixDecibelsDown() {
        let audit = VoiceCaptureAudit.audit(samples: pcm(frames: 4_000, amplitude: 16_384))

        XCTAssertEqual(audit.peakDecibels, -6.02, accuracy: 0.01)
        XCTAssertEqual(audit.rootMeanSquare, 0.5, accuracy: 0.0001)
    }

    func testDurationMatchesTheDeclaredWaveFormat() {
        let oneSecond = VoiceWaveFile.sampleRate
        let audit = VoiceCaptureAudit.audit(samples: pcm(frames: oneSecond, amplitude: 8_000))

        XCTAssertEqual(audit.durationSeconds, 1, accuracy: 0.0001)
        XCTAssertEqual(audit.byteCount, VoiceWaveFile.byteRate())
    }

    // MARK: - Rejection

    func testNothingCapturedIsRejectedAsNoAudio() {
        XCTAssertEqual(VoiceCaptureAudit.audit(samples: Data()).rejection, .noAudioCaptured)
    }

    /// Digital silence — every frame exactly zero — is the signature of an
    /// engine that ran without ever being handed the microphone.
    func testDigitalSilenceIsRejected() {
        let audit = VoiceCaptureAudit.audit(samples: pcm(frames: 32_000, amplitude: 0))

        XCTAssertTrue(audit.isDigitalSilence)
        XCTAssertEqual(audit.zeroFrameCount, 32_000)
        XCTAssertEqual(audit.rejection, .silentInput)
    }

    /// The floor is inclusive, and it sits at -60 dBFS: tens of decibels below
    /// anything a live microphone produces, so real speech never lands here.
    func testTheSilenceFloorIsInclusive() {
        let atFloor = VoiceCaptureAudit.audit(
            samples: pcm(frames: 32_000, amplitude: VoiceCaptureAudit.silenceFloorAmplitude)
        )
        let justAbove = VoiceCaptureAudit.audit(
            samples: pcm(frames: 32_000, amplitude: VoiceCaptureAudit.silenceFloorAmplitude + 1)
        )

        XCTAssertEqual(atFloor.peakAmplitude, VoiceCaptureAudit.silenceFloorAmplitude)
        XCTAssertEqual(atFloor.rejection, .silentInput)
        XCTAssertNil(justAbove.rejection)
    }

    func testTheSilenceFloorIsSixtyDecibelsDown() {
        let audit = VoiceCaptureAudit.audit(
            samples: pcm(frames: 100, amplitude: VoiceCaptureAudit.silenceFloorAmplitude)
        )

        XCTAssertEqual(audit.peakDecibels, -60.2, accuracy: 0.1)
    }

    /// The gesture machine discards holds under 500 ms and only starts
    /// recording at 300 ms, so this catches releases that land while the engine
    /// is still spinning up rather than second-guessing a legitimate hold.
    func testAPayloadShorterThanTheFloorIsRejected() {
        let frames = Int(
            VoiceCaptureAudit.minimumDurationSeconds * Double(VoiceWaveFile.sampleRate)
        )
        let justUnder = VoiceCaptureAudit.audit(samples: pcm(frames: frames - 1, amplitude: 9_000))
        let atFloor = VoiceCaptureAudit.audit(samples: pcm(frames: frames, amplitude: 9_000))

        XCTAssertEqual(justUnder.rejection, .recordingTooShort)
        XCTAssertNil(atFloor.rejection)
    }

    /// Length is checked before level, so a one-frame silent payload names the
    /// thing the user can act on rather than blaming their microphone.
    func testLengthIsCheckedBeforeLevel() {
        XCTAssertEqual(
            VoiceCaptureAudit.audit(samples: pcm(frames: 1, amplitude: 0)).rejection,
            .recordingTooShort
        )
    }

    func testOrdinarySpeechLevelsAreAccepted() {
        // -20 dBFS peak: a phone held at a normal distance with input
        // processing on.
        let audit = VoiceCaptureAudit.audit(samples: pcm(frames: 48_000, amplitude: 3_276))

        XCTAssertNil(audit.rejection)
        XCTAssertFalse(audit.isQuiet)
        XCTAssertFalse(audit.isDigitalSilence)
    }

    // MARK: - The quiet flag

    /// Not a rejection: a recording this quiet may still transcribe, but a whole
    /// take sitting under -40 dBFS means the input route is attenuating
    /// everything, which is worth seeing in the diagnostics log.
    func testAQuietTakeIsFlaggedButNotRejected() {
        let quiet = VoiceCaptureAudit.audit(samples: pcm(frames: 32_000, amplitude: 200))

        XCTAssertLessThan(quiet.peakDecibels, VoiceCaptureAudit.quietPeakDecibels)
        XCTAssertTrue(quiet.isQuiet)
        XCTAssertNil(quiet.rejection)
    }

    func testAHealthyTakeIsNotFlaggedAsQuiet() {
        XCTAssertFalse(
            VoiceCaptureAudit.audit(samples: pcm(frames: 32_000, amplitude: 6_000)).isQuiet
        )
    }

    // MARK: - Helpers

    /// `frames` frames of interleaved little-endian mono PCM alternating
    /// ±`amplitude`, which fixes both the peak and the RMS at `amplitude`.
    private func pcm(frames: Int, amplitude: Int) -> Data {
        var data = Data(capacity: frames * 2)
        for index in 0..<frames {
            let value = Int16(clamping: index.isMultiple(of: 2) ? amplitude : -amplitude)
            data.append(UInt8(UInt16(bitPattern: value) & 0xFF))
            data.append(UInt8((UInt16(bitPattern: value) >> 8) & 0xFF))
        }
        return data
    }
}
