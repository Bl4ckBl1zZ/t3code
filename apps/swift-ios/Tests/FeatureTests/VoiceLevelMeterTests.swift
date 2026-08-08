import Foundation
import XCTest

@testable import T3Code

/// The level meter's maths, which is the whole reason the bars glide instead of
/// stepping ten times a second. The view is a thin wrapper over these two, so
/// they are where the behaviour is worth pinning down.
final class VoiceLevelEnvelopeTests: XCTestCase {
    func testASampleIsReachedOnlyAfterTheAttackHasElapsed() {
        let envelope = VoiceLevelEnvelope().retargeted(to: 1, at: 100)

        XCTAssertEqual(envelope.value(at: 100), 0, accuracy: 0.0001)
        XCTAssertGreaterThan(envelope.value(at: 100 + VoiceLevelEnvelope.attackSeconds / 2), 0)
        XCTAssertEqual(
            envelope.value(at: 100 + VoiceLevelEnvelope.attackSeconds),
            1,
            accuracy: 0.0001
        )
    }

    func testTheValueHoldsOnceTheSampleHasBeenReached() {
        let envelope = VoiceLevelEnvelope().retargeted(to: 0.6, at: 0)

        XCTAssertEqual(envelope.value(at: 10), 0.6, accuracy: 0.0001)
        XCTAssertEqual(envelope.value(at: 10_000), 0.6, accuracy: 0.0001)
    }

    /// A speech envelope rises faster than it falls; without that the meter
    /// reads as a progress bar rather than as a microphone.
    func testReleaseIsSlowerThanAttack() {
        XCTAssertGreaterThan(
            VoiceLevelEnvelope.releaseSeconds,
            VoiceLevelEnvelope.attackSeconds
        )

        let rising = VoiceLevelEnvelope().retargeted(to: 1, at: 0)
        let falling = VoiceLevelEnvelope(previous: 1, target: 0, changedAt: 0)
        let elapsed = VoiceLevelEnvelope.attackSeconds

        XCTAssertEqual(rising.value(at: elapsed), 1, accuracy: 0.0001)
        XCTAssertGreaterThan(falling.value(at: elapsed), 0.4)
    }

    /// The samples land every 100 ms, well before a release has finished, so
    /// retargeting mid-glide has to continue from where the curve had reached
    /// rather than snapping back to the previous sample.
    func testRetargetingMidGlideIsContinuous() {
        let rising = VoiceLevelEnvelope().retargeted(to: 1, at: 0)
        let midpoint = VoiceLevelEnvelope.attackSeconds / 2
        let atHandover = rising.value(at: midpoint)

        let retargeted = rising.retargeted(to: 0.2, at: midpoint)

        XCTAssertEqual(retargeted.value(at: midpoint), atHandover, accuracy: 0.0001)
        XCTAssertEqual(
            retargeted.value(at: midpoint + VoiceLevelEnvelope.releaseSeconds),
            0.2,
            accuracy: 0.0001
        )
    }

    func testSamplesAreClampedToTheMeterRange() {
        XCTAssertEqual(VoiceLevelEnvelope().retargeted(to: 4.2, at: 0).value(at: 10), 1)
        XCTAssertEqual(VoiceLevelEnvelope().retargeted(to: -3, at: 0).value(at: 10), 0)
    }

    /// Smoothstep, not a linear ramp: both ends arrive with zero slope, which is
    /// what stops a corner appearing every time a sample lands.
    func testTheGlideEasesInAndOut() {
        let envelope = VoiceLevelEnvelope().retargeted(to: 1, at: 0)
        let quarter = envelope.value(at: VoiceLevelEnvelope.attackSeconds * 0.25)
        let threeQuarters = envelope.value(at: VoiceLevelEnvelope.attackSeconds * 0.75)

        XCTAssertLessThan(quarter, 0.25)
        XCTAssertGreaterThan(threeQuarters, 0.75)
        XCTAssertEqual(
            envelope.value(at: VoiceLevelEnvelope.attackSeconds * 0.5),
            0.5,
            accuracy: 0.0001
        )
    }
}

final class VoiceLevelMeterGeometryTests: XCTestCase {
    private let phases: [Double] = [0, 0.13, 0.5, 1.7, 9.4]

    func testEveryBarStaysInsideTheMeter() {
        for phase in phases {
            for level in stride(from: -0.5, through: 1.5, by: 0.1) {
                for index in 0..<VoiceLevelMeterGeometry.barCount {
                    let height = VoiceLevelMeterGeometry.height(
                        level: level,
                        phase: phase,
                        index: index
                    )
                    XCTAssertGreaterThanOrEqual(height, VoiceLevelMeterGeometry.minimumHeight)
                    XCTAssertLessThanOrEqual(height, VoiceLevelMeterGeometry.maximumHeight)
                }
            }
        }
    }

    /// The ripple is scaled by the level, so a silent microphone shows a flat
    /// meter instead of inventing motion nobody is making.
    func testSilenceIsFlatAtEveryPhase() {
        for phase in phases {
            for index in 0..<VoiceLevelMeterGeometry.barCount {
                XCTAssertEqual(
                    VoiceLevelMeterGeometry.height(level: 0, phase: phase, index: index),
                    VoiceLevelMeterGeometry.minimumHeight,
                    accuracy: 0.0001
                )
            }
        }
    }

    func testTheDomeIsTallestInTheMiddle() {
        let heights = (0..<VoiceLevelMeterGeometry.barCount).map { index in
            VoiceLevelMeterGeometry.height(level: 0.7, phase: 0, index: index)
        }
        let middle = VoiceLevelMeterGeometry.barCount / 2

        XCTAssertGreaterThan(heights[middle], heights[0])
        XCTAssertGreaterThan(heights[middle], heights[heights.count - 1])
    }

    func testALouderSampleRaisesTheMeter() {
        let quiet = VoiceLevelMeterGeometry.height(level: 0.2, phase: 0, index: 7)
        let loud = VoiceLevelMeterGeometry.height(level: 0.9, phase: 0, index: 7)

        XCTAssertGreaterThan(loud, quiet)
    }

    /// Neighbouring bars respond on different exponents, which is what keeps the
    /// meter from moving as one block.
    func testNeighbouringBarsDoNotMoveInLockstep() {
        let profiles = VoiceLevelMeterGeometry.profiles

        XCTAssertEqual(profiles.count, VoiceLevelMeterGeometry.barCount)
        XCTAssertNotEqual(profiles[6].exponent, profiles[7].exponent)
    }
}

/// The meter is the recording bar's slack: it is the one element in that row
/// that loses no information by being narrower, so the layout takes width from
/// here rather than truncating the label that tells the user what releasing
/// will do.
final class VoiceLevelMeterFlexibilityTests: XCTestCase {
    func testTheMeterCanGiveUpWidth() {
        XCTAssertLessThan(
            VoiceLevelMeterGeometry.minimumWidth,
            VoiceLevelMeterGeometry.maximumWidth
        )
        XCTAssertGreaterThan(VoiceLevelMeterGeometry.minimumBarCount, 0)
        XCTAssertLessThan(
            VoiceLevelMeterGeometry.minimumBarCount,
            VoiceLevelMeterGeometry.barCount
        )
    }

    func testWidthCountsTheGapsBetweenBars() {
        XCTAssertEqual(VoiceLevelMeterGeometry.width(barCount: 0), 0)
        XCTAssertEqual(VoiceLevelMeterGeometry.width(barCount: 1), 3)
        XCTAssertEqual(VoiceLevelMeterGeometry.width(barCount: 2), 8)
        XCTAssertEqual(
            VoiceLevelMeterGeometry.maximumWidth,
            VoiceLevelMeterGeometry.width(barCount: VoiceLevelMeterGeometry.barCount)
        )
    }

    /// Every bar the meter reports as fitting has to actually fit, or the row it
    /// lives in overflows exactly where it was supposed to yield.
    func testEveryReportedBarFitsTheWidthItWasGiven() {
        for width in stride(from: VoiceLevelMeterGeometry.minimumWidth, through: 200, by: 0.5) {
            let count = VoiceLevelMeterGeometry.barCount(fitting: width)
            XCTAssertLessThanOrEqual(VoiceLevelMeterGeometry.width(barCount: count), width)
        }
    }

    func testTheCountIsClampedToTheLegibleRange() {
        XCTAssertEqual(
            VoiceLevelMeterGeometry.barCount(fitting: 1_000),
            VoiceLevelMeterGeometry.barCount
        )
        XCTAssertEqual(
            VoiceLevelMeterGeometry.barCount(fitting: VoiceLevelMeterGeometry.maximumWidth),
            VoiceLevelMeterGeometry.barCount
        )
        for width in [-10.0, 0, 1, VoiceLevelMeterGeometry.minimumWidth - 1] as [CGFloat] {
            XCTAssertEqual(
                VoiceLevelMeterGeometry.barCount(fitting: width),
                VoiceLevelMeterGeometry.minimumBarCount
            )
        }
        XCTAssertEqual(
            VoiceLevelMeterGeometry.barCount(fitting: .nan),
            VoiceLevelMeterGeometry.minimumBarCount
        )
    }

    func testWideningTheMeterNeverRemovesBars() {
        var previous = 0
        for width in stride(from: 0.0, through: 120, by: 0.5) {
            let count = VoiceLevelMeterGeometry.barCount(fitting: width)
            XCTAssertGreaterThanOrEqual(count, previous)
            previous = count
        }
    }

    /// The dome is described in normalized position, so a narrower meter is the
    /// same shape rendered with fewer bars rather than the full curve with its
    /// ends chopped off.
    func testTheDomeKeepsItsShapeAtEveryWidth() {
        for count in VoiceLevelMeterGeometry.minimumBarCount...VoiceLevelMeterGeometry.barCount {
            let profiles = VoiceLevelMeterGeometry.profiles(count: count)
            XCTAssertEqual(profiles.count, count)

            let heights = (0..<count).map {
                VoiceLevelMeterGeometry.height(level: 0.7, phase: 0, index: $0, count: count)
            }
            XCTAssertGreaterThan(heights[count / 2], heights[0])
            XCTAssertGreaterThan(heights[count / 2], heights[count - 1])
        }
    }

    func testEveryBarStaysInsideTheMeterAtEveryWidth() {
        for count in VoiceLevelMeterGeometry.minimumBarCount...VoiceLevelMeterGeometry.barCount {
            for phase in [0.0, 0.4, 3.1] {
                for level in stride(from: -0.5, through: 1.5, by: 0.25) {
                    for index in 0..<count {
                        let height = VoiceLevelMeterGeometry.height(
                            level: level,
                            phase: phase,
                            index: index,
                            count: count
                        )
                        XCTAssertGreaterThanOrEqual(height, VoiceLevelMeterGeometry.minimumHeight)
                        XCTAssertLessThanOrEqual(height, VoiceLevelMeterGeometry.maximumHeight)
                    }
                }
            }
        }
    }

    /// An out-of-range index is clamped rather than trapped: the count the view
    /// renders at and the count the geometry is asked about are resolved in
    /// different layout passes, so they can disagree for a frame.
    func testAnOutOfRangeIndexIsClamped() {
        for index in [-5, 99] {
            let height = VoiceLevelMeterGeometry.height(
                level: 0.5,
                phase: 0,
                index: index,
                count: VoiceLevelMeterGeometry.minimumBarCount
            )
            XCTAssertGreaterThanOrEqual(height, VoiceLevelMeterGeometry.minimumHeight)
            XCTAssertLessThanOrEqual(height, VoiceLevelMeterGeometry.maximumHeight)
        }
    }

    func testAnOutOfRangeCountIsClamped() {
        XCTAssertEqual(
            VoiceLevelMeterGeometry.profiles(count: 1).count,
            VoiceLevelMeterGeometry.minimumBarCount
        )
        XCTAssertEqual(
            VoiceLevelMeterGeometry.profiles(count: 999).count,
            VoiceLevelMeterGeometry.barCount
        )
    }

    /// The default keeps the meter's pre-existing callers — and the geometry
    /// tests above — describing the full-width meter.
    func testTheDefaultCountIsTheFullMeter() {
        XCTAssertEqual(
            VoiceLevelMeterGeometry.height(level: 0.6, phase: 1.2, index: 3),
            VoiceLevelMeterGeometry.height(
                level: 0.6,
                phase: 1.2,
                index: 3,
                count: VoiceLevelMeterGeometry.barCount
            )
        )
    }
}
