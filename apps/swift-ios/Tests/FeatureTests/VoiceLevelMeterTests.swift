import XCTest

@testable import T3Code

/// The recording strip's waveform is a rolling tape of level samples: newest at
/// the right edge, silence and the not-yet-recorded remainder as baseline dots.
final class VoiceWaveformHistoryTests: XCTestCase {
    func testSamplesAreClampedToTheDisplayableRange() {
        var history = VoiceWaveformHistory()
        history.append(4.2)
        history.append(-3)

        XCTAssertEqual(history.samples, [1, 0])
    }

    func testTheWindowIsRightAlignedAndPaddedWithBaseline() {
        var history = VoiceWaveformHistory()
        history.append(0.5)
        history.append(0.8)

        XCTAssertEqual(history.bars(slots: 5), [0, 0, 0, 0.5, 0.8])
    }

    func testAFullTapeShowsOnlyTheNewestSamples() {
        var history = VoiceWaveformHistory()
        for sample in [0.1, 0.2, 0.3, 0.4] {
            history.append(sample)
        }

        XCTAssertEqual(history.bars(slots: 2), [0.3, 0.4])
    }

    func testZeroOrNegativeSlotsRenderNothing() {
        var history = VoiceWaveformHistory()
        history.append(0.5)

        XCTAssertEqual(history.bars(slots: 0), [])
        XCTAssertEqual(history.bars(slots: -3), [])
    }

    /// The capacity is a memory bound, not a display decision: it only has to
    /// exceed what any width can show, and overflowing drops the oldest.
    func testTheTapeDropsItsOldestSamplesAtCapacity() {
        var history = VoiceWaveformHistory()
        for index in 0...VoiceWaveformHistory.capacity {
            history.append(index.isMultiple(of: 2) ? 0.25 : 0.75)
        }

        XCTAssertEqual(history.samples.count, VoiceWaveformHistory.capacity)
        XCTAssertEqual(
            history.samples.last,
            VoiceWaveformHistory.capacity.isMultiple(of: 2) ? 0.25 : 0.75
        )
    }
}

final class VoiceWaveformGeometryTests: XCTestCase {
    func testEveryBarStaysInsideTheStrip() {
        for sample in stride(from: -0.5, through: 1.5, by: 0.1) {
            let height = VoiceWaveformGeometry.height(for: sample)
            XCTAssertGreaterThanOrEqual(height, VoiceWaveformGeometry.minimumHeight)
            XCTAssertLessThanOrEqual(height, VoiceWaveformGeometry.maximumHeight)
        }
    }

    func testSilenceIsTheBaselineDotAndAShoutIsFullHeight() {
        XCTAssertEqual(VoiceWaveformGeometry.height(for: 0), VoiceWaveformGeometry.minimumHeight)
        XCTAssertEqual(VoiceWaveformGeometry.height(for: 1), VoiceWaveformGeometry.maximumHeight)
    }

    func testALouderSampleRaisesTheBar() {
        XCTAssertGreaterThan(
            VoiceWaveformGeometry.height(for: 0.9),
            VoiceWaveformGeometry.height(for: 0.2)
        )
    }

    /// Every slot the geometry reports as fitting has to actually fit, or the
    /// waveform overflows into the controls beside it.
    func testEveryReportedSlotFitsTheWidthItWasGiven() {
        for width in stride(from: 0.0, through: 400, by: 0.5) {
            let slots = VoiceWaveformGeometry.slots(fitting: width)
            guard slots > 0 else { continue }
            let used = CGFloat(slots) * VoiceWaveformGeometry.barWidth
                + CGFloat(slots - 1) * VoiceWaveformGeometry.barSpacing
            XCTAssertLessThanOrEqual(used, width)
        }
    }

    func testAnUnusableWidthRendersNothing() {
        XCTAssertEqual(VoiceWaveformGeometry.slots(fitting: 0), 0)
        XCTAssertEqual(VoiceWaveformGeometry.slots(fitting: -10), 0)
        XCTAssertEqual(VoiceWaveformGeometry.slots(fitting: .nan), 0)
        XCTAssertEqual(VoiceWaveformGeometry.slots(fitting: .infinity), 0)
    }

    func testWideningTheStripNeverRemovesBars() {
        var previous = 0
        for width in stride(from: 0.0, through: 400, by: 0.5) {
            let slots = VoiceWaveformGeometry.slots(fitting: width)
            XCTAssertGreaterThanOrEqual(slots, previous)
            previous = slots
        }
    }
}
