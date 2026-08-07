import Foundation
import XCTest

@testable import T3Code

/// The recording format is load-bearing, not a quality preference: transcription
/// providers reject iOS-encoded AAC/m4a, so the capture path writes 16 kHz mono
/// 16-bit PCM and wraps it in the header assembled here. A wrong field is not a
/// degraded recording, it is a file every decoder refuses.
final class VoiceWaveFileTests: XCTestCase {
    private let sampleByteCount = 32_000

    func testTheHeaderIsTheCanonical44ByteRIFFLayout() {
        let header = VoiceWaveFile.header(dataByteCount: sampleByteCount)

        XCTAssertEqual(header.count, VoiceWaveFile.headerByteCount)
        XCTAssertEqual(header.count, 44)
        XCTAssertEqual(ascii(header, at: 0, length: 4), "RIFF")
        XCTAssertEqual(ascii(header, at: 8, length: 4), "WAVE")
        XCTAssertEqual(ascii(header, at: 12, length: 4), "fmt ")
        XCTAssertEqual(ascii(header, at: 36, length: 4), "data")
    }

    func testTheFormatChunkDeclaresSixteenKilohertzMonoPCM() {
        let header = VoiceWaveFile.header(dataByteCount: sampleByteCount)

        XCTAssertEqual(uint32(header, at: 16), 16, "PCM keeps a 16-byte fmt chunk")
        XCTAssertEqual(uint16(header, at: 20), 1, "WAVE_FORMAT_PCM")
        XCTAssertEqual(uint16(header, at: 22), 1, "mono")
        XCTAssertEqual(uint32(header, at: 24), 16_000)
        // A byte rate that disagrees with the sample rate makes decoders play
        // the recording at the wrong speed, which reads to a transcriber as a
        // different voice entirely.
        XCTAssertEqual(uint32(header, at: 28), 32_000, "16000 × 1 channel × 2 bytes")
        XCTAssertEqual(uint16(header, at: 32), 2, "block align")
        XCTAssertEqual(uint16(header, at: 34), 16, "bits per sample")
    }

    func testTheChunkSizesAccountForThePayload() {
        let header = VoiceWaveFile.header(dataByteCount: sampleByteCount)

        // RIFF counts everything after its own size field.
        XCTAssertEqual(uint32(header, at: 4), UInt32(36 + sampleByteCount))
        XCTAssertEqual(uint32(header, at: 40), UInt32(sampleByteCount))
    }

    func testAnEmptyRecordingStillProducesAValidHeader() {
        let header = VoiceWaveFile.header(dataByteCount: 0)

        XCTAssertEqual(header.count, 44)
        XCTAssertEqual(uint32(header, at: 4), 36)
        XCTAssertEqual(uint32(header, at: 40), 0)
    }

    func testEveryMultiByteFieldIsLittleEndian() {
        // 0x00003E80 == 16000. Big-endian ordering would put 0x00 first and
        // every decoder would read a 0 Hz sample rate.
        let header = VoiceWaveFile.header(dataByteCount: 0)

        XCTAssertEqual(Array(header[24..<28]), [0x80, 0x3E, 0x00, 0x00])
    }

    func testTheFileIsTheHeaderFollowedVerbatimByTheSamples() {
        let samples = Data((0..<64).map { UInt8($0) })
        let file = VoiceWaveFile.file(samples: samples)

        XCTAssertEqual(file.count, 44 + samples.count)
        XCTAssertEqual(Data(file.prefix(44)), VoiceWaveFile.header(dataByteCount: samples.count))
        XCTAssertEqual(Data(file.suffix(samples.count)), samples)
    }

    func testDurationDerivesFromTheDeclaredByteRate() {
        XCTAssertEqual(VoiceWaveFile.durationSeconds(dataByteCount: 32_000), 1, accuracy: 0.0001)
        XCTAssertEqual(VoiceWaveFile.durationSeconds(dataByteCount: 16_000), 0.5, accuracy: 0.0001)
        XCTAssertEqual(VoiceWaveFile.durationSeconds(dataByteCount: 0), 0, accuracy: 0.0001)
    }

    /// The whole reason the format was pinned: a maximum-length recording has to
    /// stay inside the relay's upload cap even after base64 expands it by a third.
    func testAMaximumLengthRecordingStaysUnderTheUploadCap() {
        let bytes = Int(VoiceInputLimits.maximumDurationSeconds) * VoiceWaveFile.byteRate()
        let encodedBytes = (bytes + VoiceWaveFile.headerByteCount + 2) / 3 * 4

        XCTAssertEqual(bytes, 3_840_000)
        XCTAssertLessThan(encodedBytes, VoiceInputLimits.maximumAudioBytes)
    }

    private func ascii(_ data: Data, at offset: Int, length: Int) -> String {
        String(decoding: data[offset..<(offset + length)], as: UTF8.self)
    }

    private func uint16(_ data: Data, at offset: Int) -> UInt16 {
        UInt16(data[offset]) | UInt16(data[offset + 1]) << 8
    }

    private func uint32(_ data: Data, at offset: Int) -> UInt32 {
        UInt32(data[offset])
            | UInt32(data[offset + 1]) << 8
            | UInt32(data[offset + 2]) << 16
            | UInt32(data[offset + 3]) << 24
    }
}
