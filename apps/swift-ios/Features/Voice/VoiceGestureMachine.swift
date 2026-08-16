import Foundation

// Ported from packages/client-runtime/src/voice/gesture.ts.
//
// Pure press/move/release classification for the combined send/record button.
// The view owns touches and the hold timer: it forwards press/move/release/
// interrupt, schedules one `holdElapsed` at `holdClassifyMs` after the press,
// and maps the returned effects onto the controller.

public struct VoiceGestureConfig: Sendable, Equatable {
    /// A press shorter than this is a tap; reaching it classifies a hold.
    public var holdClassifyMilliseconds: Double
    /// A hold released before this (from press) is an accidental graze:
    /// discard, never transcribe.
    public var tooShortMilliseconds: Double
    /// Upward travel, in points, that arms slide-to-cancel.
    public var cancelDistance: Double
    /// Travel must drop this far back below `cancelDistance` to disarm.
    public var cancelHysteresis: Double

    public init(
        holdClassifyMilliseconds: Double,
        tooShortMilliseconds: Double,
        cancelDistance: Double,
        cancelHysteresis: Double
    ) {
        self.holdClassifyMilliseconds = holdClassifyMilliseconds
        self.tooShortMilliseconds = tooShortMilliseconds
        self.cancelDistance = cancelDistance
        self.cancelHysteresis = cancelHysteresis
    }

    /// A hold is a "keep still, keep talking" gesture: the hand drifts while
    /// dictating, so the cancel zone sits ~2 cm of upward travel away and the
    /// hysteresis band is wide enough that easing back off it disarms rather
    /// than leaving the release primed to discard.
    public static let `default` = VoiceGestureConfig(
        holdClassifyMilliseconds: 300,
        tooShortMilliseconds: 500,
        cancelDistance: 128,
        cancelHysteresis: 48
    )
}

public enum VoiceGestureState: Sendable, Equatable {
    case idle
    case pressing(pressedAt: Double, startY: Double)
    /// `travel` is upward travel from the press point and is never negative.
    case holding(pressedAt: Double, startY: Double, travel: Double, cancelArmed: Bool)

    public var isHolding: Bool {
        if case .holding = self { return true }
        return false
    }

    public var cancelArmed: Bool {
        if case let .holding(_, _, _, armed) = self { return armed }
        return false
    }
}

public enum VoiceGestureEvent: Sendable, Equatable {
    case press(at: Double, y: Double)
    case move(y: Double)
    case holdElapsed
    case release(at: Double)
    case interrupt
}

public enum VoiceGestureEffect: Sendable, Equatable {
    public enum CancelReason: Sendable, Equatable {
        case swipe
        case tooShort
    }

    /// Released before the hold threshold: send when the draft has text,
    /// otherwise toggle hands-free recording.
    case tap
    /// The press is now a push-to-talk hold; start capture.
    case holdClassified
    case stopAndTranscribe
    /// Discarding is deliberate-only: a swipe-up held through the release, or a
    /// graze too short to have captured anything. Nothing the platform does to
    /// the touch stream discards audio.
    case cancelRecording(reason: CancelReason)
    /// Crossing (or leaving) the cancel zone; drives the target and a haptic.
    case cancelArmedChanged(armed: Bool)
}

public struct VoiceGestureTransition: Sendable, Equatable {
    public let state: VoiceGestureState
    public let effects: [VoiceGestureEffect]
}

public enum VoiceGestureMachine {
    public static func transition(
        _ state: VoiceGestureState,
        _ event: VoiceGestureEvent,
        config: VoiceGestureConfig = .default
    ) -> VoiceGestureTransition {
        switch event {
        case let .press(at, y):
            guard state == .idle else { return VoiceGestureTransition(state: state, effects: []) }
            return VoiceGestureTransition(
                state: .pressing(pressedAt: at, startY: y),
                effects: []
            )

        case .holdElapsed:
            guard case let .pressing(pressedAt, startY) = state else {
                return VoiceGestureTransition(state: state, effects: [])
            }
            return VoiceGestureTransition(
                state: .holding(
                    pressedAt: pressedAt,
                    startY: startY,
                    travel: 0,
                    cancelArmed: false
                ),
                effects: [.holdClassified]
            )

        case let .move(y):
            guard case let .holding(pressedAt, startY, _, wasArmed) = state else {
                return VoiceGestureTransition(state: state, effects: [])
            }
            let travel = max(0, startY - y)
            let armed = wasArmed
                ? travel > config.cancelDistance - config.cancelHysteresis
                : travel >= config.cancelDistance
            return VoiceGestureTransition(
                state: .holding(
                    pressedAt: pressedAt,
                    startY: startY,
                    travel: travel,
                    cancelArmed: armed
                ),
                effects: armed == wasArmed ? [] : [.cancelArmedChanged(armed: armed)]
            )

        case let .release(at):
            switch state {
            case .pressing:
                return VoiceGestureTransition(state: .idle, effects: [.tap])
            case let .holding(pressedAt, _, _, cancelArmed):
                if cancelArmed {
                    return VoiceGestureTransition(
                        state: .idle,
                        effects: [.cancelRecording(reason: .swipe)]
                    )
                }
                if at - pressedAt < config.tooShortMilliseconds {
                    return VoiceGestureTransition(
                        state: .idle,
                        effects: [.cancelRecording(reason: .tooShort)]
                    )
                }
                return VoiceGestureTransition(state: .idle, effects: [.stopAndTranscribe])
            case .idle:
                return VoiceGestureTransition(state: state, effects: [])
            }

        case .interrupt:
            // The platform lost the touch. The finger never asked for anything,
            // so this keeps whatever was captured instead of discarding it —
            // including while cancel is armed, because arming alone is not the
            // cancel decision; releasing on the target is.
            if state.isHolding {
                return VoiceGestureTransition(state: .idle, effects: [.stopAndTranscribe])
            }
            return VoiceGestureTransition(state: .idle, effects: [])
        }
    }

    /// 0...1 progress toward the cancel threshold, for scaling the target.
    public static func cancelProgress(
        _ state: VoiceGestureState,
        config: VoiceGestureConfig = .default
    ) -> Double {
        guard case let .holding(_, _, travel, _) = state, config.cancelDistance > 0 else {
            return 0
        }
        return min(1, travel / config.cancelDistance)
    }
}
