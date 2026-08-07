import Foundation
import XCTest

@testable import T3Code

/// Ports packages/client-runtime/src/voice/gesture.test.ts.
///
/// The rule the whole gesture protects: push-to-talk, not slide-to-cancel.
/// Release confirms from anywhere on screen, and only a swipe-up still held past
/// the cancel distance at the moment of release throws the audio away.
final class VoiceGestureMachineTests: XCTestCase {
    private let config = VoiceGestureConfig.default

    func testAQuickReleaseIsATap() {
        let run = run([.press(at: 0, y: 500), .release(at: 120)])

        XCTAssertEqual(run.state, .idle)
        XCTAssertEqual(run.effects, [.tap])
    }

    func testAHeldPressTranscribesOnRelease() {
        let run = run([.press(at: 0, y: 500), .holdElapsed, .release(at: 2_000)])

        XCTAssertEqual(run.state, .idle)
        XCTAssertEqual(run.effects, [.holdClassified, .stopAndTranscribe])
    }

    func testAGrazeShorterThanTheThresholdIsDiscarded() {
        let run = run([
            .press(at: 0, y: 500),
            .holdElapsed,
            .release(at: config.tooShortMilliseconds - 1),
        ])

        XCTAssertEqual(run.effects, [.holdClassified, .cancelRecording(reason: .tooShort)])
    }

    func testASwipeUpHeldThroughTheReleaseDiscards() {
        let run = run([
            .press(at: 0, y: 500),
            .holdElapsed,
            .move(y: 500 - config.cancelDistance),
            .release(at: 5_000),
        ])

        XCTAssertEqual(
            run.effects,
            [
                .holdClassified,
                .cancelArmedChanged(armed: true),
                .cancelRecording(reason: .swipe),
            ]
        )
    }

    /// The hand drifts while dictating, so leaving the zone has to disarm rather
    /// than leaving the release primed to discard.
    func testDisarmingRequiresClearingTheHysteresisBand() {
        let armed = config.cancelDistance
        let stillArmed = armed - config.cancelHysteresis + 1
        let disarmed = armed - config.cancelHysteresis - 1

        let run = run([
            .press(at: 0, y: 500),
            .holdElapsed,
            .move(y: 500 - armed),
            .move(y: 500 - stillArmed),
            .move(y: 500 - disarmed),
            .release(at: 5_000),
        ])

        XCTAssertEqual(
            run.effects,
            [
                .holdClassified,
                .cancelArmedChanged(armed: true),
                .cancelArmedChanged(armed: false),
                .stopAndTranscribe,
            ]
        )
    }

    func testDownwardMovementNeverReportsNegativeTravel() {
        let run = run([.press(at: 0, y: 500), .holdElapsed, .move(y: 900)])

        XCTAssertEqual(
            run.state,
            .holding(pressedAt: 0, startY: 500, travel: 0, cancelArmed: false)
        )
        XCTAssertEqual(VoiceGestureMachine.cancelProgress(run.state), 0)
    }

    func testAFingerThatWanderedAnywhereButTheCancelZoneStillTranscribes() {
        let run = run([
            .press(at: 0, y: 500),
            .holdElapsed,
            .move(y: 900),
            .move(y: 500 - (config.cancelDistance - 1)),
            .move(y: 620),
            .release(at: 4_000),
        ])

        XCTAssertEqual(run.effects, [.holdClassified, .stopAndTranscribe])
    }

    /// A stolen touch is the platform's decision, not the user's, so it keeps
    /// what was captured — including while cancel is armed, because arming is
    /// not the cancel decision; releasing on the target is.
    func testAnInterruptedHoldKeepsTheRecording() {
        let pressing = run([.press(at: 0, y: 500), .interrupt])
        XCTAssertEqual(pressing.state, .idle)
        XCTAssertEqual(pressing.effects, [])

        let holding = run([.press(at: 0, y: 500), .holdElapsed, .interrupt])
        XCTAssertEqual(holding.state, .idle)
        XCTAssertEqual(holding.effects, [.holdClassified, .stopAndTranscribe])

        let armed = run([
            .press(at: 0, y: 500),
            .holdElapsed,
            .move(y: 500 - config.cancelDistance),
            .interrupt,
        ])
        XCTAssertEqual(
            armed.effects,
            [.holdClassified, .cancelArmedChanged(armed: true), .stopAndTranscribe]
        )
    }

    func testStrayEventsOutsideTheirStatesAreIgnored() {
        XCTAssertEqual(VoiceGestureMachine.transition(.idle, .release(at: 10)).effects, [])
        XCTAssertEqual(VoiceGestureMachine.transition(.idle, .move(y: 10)).effects, [])
        XCTAssertEqual(VoiceGestureMachine.transition(.idle, .holdElapsed).effects, [])

        let pressing = run([.press(at: 0, y: 500)]).state
        XCTAssertEqual(
            VoiceGestureMachine.transition(pressing, .press(at: 5, y: 400)).state,
            pressing
        )
    }

    func testCancelProgressReportsHowCloseTheReleaseIsToDiscarding() {
        let halfway = run([
            .press(at: 0, y: 500),
            .holdElapsed,
            .move(y: 500 - config.cancelDistance / 2),
        ]).state

        XCTAssertEqual(VoiceGestureMachine.cancelProgress(halfway), 0.5, accuracy: 0.0001)
        XCTAssertEqual(VoiceGestureMachine.cancelProgress(.idle), 0)
    }

    private func run(
        _ events: [VoiceGestureEvent]
    ) -> (state: VoiceGestureState, effects: [VoiceGestureEffect]) {
        var state = VoiceGestureState.idle
        var effects: [VoiceGestureEffect] = []
        for event in events {
            let transition = VoiceGestureMachine.transition(state, event, config: config)
            state = transition.state
            effects.append(contentsOf: transition.effects)
        }
        return (state, effects)
    }
}
