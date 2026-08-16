import Foundation
import XCTest
@testable import T3Code

/// Covers the four registration behaviours ported from
/// apps/mobile/src/features/agent-awareness/remoteRegistration.ts.
final class LiveActivityRegistrationHardeningTests: XCTestCase {
    // MARK: - One managed push-token subscription

    /// `Activity<Attributes>.activities` returns fresh value-type wrappers on
    /// every call. The RN code's `WeakSet` dedupe keyed off those wrappers, so
    /// it both re-attached a listener on every poll and never recognized an
    /// activity it was already listening to. Keying off the stable id means a
    /// repeated poll of the same card is a no-op.
    func testPollingTheSameCardNeverReattachesTheListener() {
        let first = PlatformActivityTokenSubscription.plan(
            activityIDs: ["card-a"],
            observing: nil
        )
        let second = PlatformActivityTokenSubscription.plan(
            activityIDs: ["card-a"],
            observing: first.observe
        )

        XCTAssertEqual(first.observe, "card-a")
        XCTAssertTrue(first.replacesSubscription)
        XCTAssertEqual(second.observe, "card-a")
        XCTAssertFalse(second.replacesSubscription)
    }

    func testExactlyOneCardIsObservedAndTheRestAreReportedRedundant() {
        let plan = PlatformActivityTokenSubscription.plan(
            activityIDs: ["card-a", "card-b", "card-c"],
            observing: nil
        )

        XCTAssertEqual(plan.observe, "card-a")
        // The relay tracks exactly one card per device.
        XCTAssertEqual(plan.redundant, ["card-b", "card-c"])
    }

    func testTheSubscriptionMovesWhenThePrimaryCardChangesOrDisappears() {
        let replaced = PlatformActivityTokenSubscription.plan(
            activityIDs: ["card-b"],
            observing: "card-a"
        )
        let cleared = PlatformActivityTokenSubscription.plan(
            activityIDs: [],
            observing: "card-a"
        )

        XCTAssertEqual(replaced.observe, "card-b")
        XCTAssertTrue(replaced.replacesSubscription)
        XCTAssertNil(cleared.observe)
        XCTAssertTrue(cleared.replacesSubscription)
        XCTAssertTrue(cleared.redundant.isEmpty)
    }

    // MARK: - Freshly-armed grace

    func testAJustArmedCardSurvivesAnEmptyRelayAggregate() {
        let armedAt = Date(timeIntervalSince1970: 1_000)

        XCTAssertFalse(
            PlatformLiveActivityArming.shouldEndForEmptyAggregate(
                armedAt: armedAt,
                now: armedAt.addingTimeInterval(1)
            )
        )
        XCTAssertFalse(
            PlatformLiveActivityArming.shouldEndForEmptyAggregate(
                armedAt: armedAt,
                now: armedAt.addingTimeInterval(PlatformLiveActivityArming.gracePeriod - 1)
            )
        )
    }

    func testTheGraceIsTwoMinutesAndExpiresOnTheBoundary() {
        let armedAt = Date(timeIntervalSince1970: 1_000)

        XCTAssertEqual(PlatformLiveActivityArming.gracePeriod, 120)
        XCTAssertTrue(
            PlatformLiveActivityArming.shouldEndForEmptyAggregate(
                armedAt: armedAt,
                now: armedAt.addingTimeInterval(PlatformLiveActivityArming.gracePeriod)
            )
        )
        XCTAssertTrue(
            PlatformLiveActivityArming.shouldEndForEmptyAggregate(
                armedAt: armedAt,
                now: armedAt.addingTimeInterval(600)
            )
        )
    }

    /// Nothing armed means nothing to protect: an empty aggregate ends whatever
    /// orphan is on the lock screen.
    func testAnUnarmedCardIsEndedImmediately() {
        XCTAssertTrue(
            PlatformLiveActivityArming.shouldEndForEmptyAggregate(
                armedAt: nil,
                now: Date(timeIntervalSince1970: 1_000)
            )
        )
    }

    // MARK: - Token-registry expiry pruning

    func testExpiredAcceptancesArePrunedSoAForegroundReplaysTheAggregate() {
        let now: TimeInterval = 10_000
        let pruned = PlatformActivityTokenRegistry.pruned(
            [
                "fresh": now - 5,
                "stale": now - PlatformActivityTokenRegistry.reregisterInterval,
                "ancient": now - 86_400,
            ],
            now: now
        )

        XCTAssertEqual(Set(pruned.keys), ["fresh"])
        XCTAssertTrue(
            PlatformActivityTokenRegistry.isFresh(pruned, fingerprint: "fresh", now: now)
        )
        // Aged out, so the next pass re-registers — which is what makes the
        // relay replay the current aggregate to this device.
        XCTAssertFalse(
            PlatformActivityTokenRegistry.isFresh(pruned, fingerprint: "stale", now: now)
        )
    }

    func testTheRegistryIsBoundedToTheNewestEntries() {
        let now: TimeInterval = 10_000
        let crowded = Dictionary(
            uniqueKeysWithValues: (0..<20).map { ("token-\($0)", now - Double(20 - $0)) }
        )

        let pruned = PlatformActivityTokenRegistry.pruned(crowded, now: now)

        XCTAssertEqual(pruned.count, PlatformActivityTokenRegistry.maximumEntries)
        XCTAssertTrue(pruned.keys.contains("token-19"))
        XCTAssertFalse(pruned.keys.contains("token-0"))
    }

    func testRecordingAnAcceptanceAlsoPrunes() {
        let now: TimeInterval = 10_000
        let recorded = PlatformActivityTokenRegistry.recording(
            ["stale": now - 3_600],
            fingerprint: "accepted",
            now: now
        )

        XCTAssertEqual(Set(recorded.keys), ["accepted"])
        XCTAssertEqual(recorded["accepted"], now)
    }

    /// Bursts (sign-in + foreground + connection update) collapse to one request
    /// while a foreground after real time away still replays.
    func testTheRereregisterWindowIsShortEnoughToStillReplayAfterTimeAway() {
        let now: TimeInterval = 10_000
        let registry = ["token": now - 30]

        XCTAssertEqual(PlatformActivityTokenRegistry.reregisterInterval, 60)
        XCTAssertTrue(PlatformActivityTokenRegistry.isFresh(registry, fingerprint: "token", now: now))
        XCTAssertFalse(
            PlatformActivityTokenRegistry.isFresh(registry, fingerprint: "token", now: now + 31)
        )
    }

    // MARK: - repaint-live-activity

    func testTheRepaintOperationKeepsItsRelayWireName() {
        XCTAssertEqual(
            PlatformAgentAwarenessOperation.repaintLiveActivity.rawValue,
            "repaint-live-activity"
        )
        XCTAssertEqual(
            PlatformAgentAwarenessOperationError(operation: .repaintLiveActivity)
                .errorDescription,
            "Agent awareness operation repaint-live-activity failed."
        )
    }

    @MainActor
    func testRepaintReappliesAnUnchangedAggregateThatSynchronizeWouldSkip() async {
        let recorder = LiveActivityRepaintRecorder()
        let coordinator = PlatformAgentAwarenessCoordinator(
            updateLiveActivity: { aggregate, _, _ in
                await recorder.record(aggregate.activeCount)
            },
            endLiveActivities: {}
        )

        coordinator.synchronize(snapshot: FeatureSnapshot(), liveActivitiesEnabled: true)
        await recorder.waitForCount(1)
        // The dedupe is exactly what a repaint has to bypass.
        coordinator.synchronize(snapshot: FeatureSnapshot(), liveActivitiesEnabled: true)
        await Task.yield()
        let afterDuplicateSnapshot = await recorder.count
        XCTAssertEqual(afterDuplicateSnapshot, 1)

        coordinator.repaintLiveActivity()
        await recorder.waitForCount(2)
        let afterRepaint = await recorder.count
        XCTAssertEqual(afterRepaint, 2)
    }

    @MainActor
    func testRepaintWithoutAPriorProjectionDoesNothing() async {
        let recorder = LiveActivityRepaintRecorder()
        let coordinator = PlatformAgentAwarenessCoordinator(
            updateLiveActivity: { aggregate, _, _ in
                await recorder.record(aggregate.activeCount)
            },
            endLiveActivities: {}
        )

        coordinator.repaintLiveActivity()
        await Task.yield()
        await Task.yield()

        let count = await recorder.count
        XCTAssertEqual(count, 0)
    }
}

private actor LiveActivityRepaintRecorder {
    private(set) var count = 0
    private(set) var activeCounts: [Int] = []

    func record(_ activeCount: Int) {
        count += 1
        activeCounts.append(activeCount)
    }

    func waitForCount(_ target: Int) async {
        for _ in 0..<200 where count < target {
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
    }
}
