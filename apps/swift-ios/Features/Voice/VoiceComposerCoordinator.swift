import Foundation
import Observation
import UIKit

// Ported from apps/mobile/src/features/voice/useVoiceComposer.ts and
// useMobileVoiceInput.ts.

/// What a tap on the combined send/record button does when nothing is being
/// recorded. Supplied per event because it changes with the draft.
public struct VoiceComboButtonAction {
    public let canSend: Bool
    public let send: () -> Void

    public init(canSend: Bool, send: @escaping () -> Void) {
        self.canSend = canSend
        self.send = send
    }
}

public struct VoiceComposerAlert: Identifiable, Equatable {
    public enum Kind: Equatable {
        /// Acknowledge only.
        case notice
        /// Cancel / Open Settings.
        case permissionBlocked
        /// Cancel / Try again.
        case permissionRetry
        /// Discard / Retry.
        case failureRetry
    }

    public let id = UUID()
    public let title: String
    public let message: String
    public let kind: Kind
}

/// The composer-side glue for Voice Input: anchors the insertion point when
/// recording starts, inserts the transcript on completion (falling back to the
/// live caret when the draft changed mid-recording), stashes transcripts whose
/// composer went away, and surfaces failures.
@MainActor
@Observable
public final class VoiceComposerCoordinator {
    /// One app-wide coordinator, for the same reason the stash is app-wide and
    /// because there is only one microphone: a recording started in one
    /// conversation has to survive being navigated away from, and the composer
    /// that comes back has to be able to claim its transcript.
    public static let shared = VoiceComposerCoordinator()

    /// Observed rather than ignored so that adopting a controller — which only
    /// happens once the relay capability resolves — re-evaluates the composer.
    /// Reading `controller.state` through it tracks the controller's own
    /// observation, so no mirroring is needed.
    public private(set) var controller: VoiceInputController?

    public var state: VoiceInputState { controller?.state ?? .idle }
    public var level: Double { controller?.level ?? 0 }
    /// A push-to-talk finger is down.
    public private(set) var holdActive = false

    /// Whether a finger is currently down on the combo button, from touch-down
    /// rather than from the moment a hold classifies. The composer's
    /// keyboard-dismiss drag reads this: a push-to-talk hold is a drag, and
    /// without the guard sliding on the mic dismisses the keyboard under the
    /// user mid-recording.
    ///
    /// A method, not a property, because it reads `@ObservationIgnored` state
    /// deliberately — observing it would invalidate the whole thread view on
    /// every touch-down and every move of a hold. Valid only for imperative
    /// reads from a gesture callback; rendering from it gives a stale view.
    public func ownsActiveTouch() -> Bool { gestureState != .idle }
    public private(set) var cancelArmed = false
    /// 0...1, quantized to 5% steps so a hold re-renders at most 20 times.
    public private(set) var cancelProgress: Double = 0
    public var alert: VoiceComposerAlert?
    /// Set when Voice Input needs an OpenRouter credential, so the composer can
    /// point at Settings.
    public private(set) var needsOpenRouter = false

    @ObservationIgnored private let stash: VoiceTranscriptStash
    @ObservationIgnored private let preflight: VoicePreflightCache
    @ObservationIgnored private let gestureConfig: VoiceGestureConfig
    @ObservationIgnored private let makeCapture: @MainActor () -> any VoiceCapturing

    @ObservationIgnored private var capability: (any FeatureVoiceTranscribing)?
    @ObservationIgnored private var identity = ""
    @ObservationIgnored private var readDraft: () -> String = { "" }
    @ObservationIgnored private var writeDraft: (String) -> Void = { _ in }
    @ObservationIgnored private var readRange: (String) -> VoiceTextRange = {
        VoiceTextRange(caret: $0.utf16.count)
    }
    @ObservationIgnored private var moveCaret: (Int) -> Void = { _ in }

    @ObservationIgnored private var anchor: VoiceComposerAnchor?
    @ObservationIgnored private var gestureState: VoiceGestureState = .idle
    @ObservationIgnored private var holdTask: Task<Void, Never>?
    /// Whether this hold started the recording (rather than grabbing one that
    /// was already running hands-free): decides if a too-short release discards
    /// or merely stops.
    @ObservationIgnored private var holdOwnsSession = false
    /// The finger lifted before startup reached `recording`; stop as soon as it
    /// does.
    @ObservationIgnored private var stopOnRecording = false
    @ObservationIgnored private var alertedFailure: VoiceInputState?
    @ObservationIgnored private var activeTask: Task<Void, Never>?

    public init(
        stash: VoiceTranscriptStash = .shared,
        preflight: VoicePreflightCache = .shared,
        gestureConfig: VoiceGestureConfig = .default,
        makeCapture: @escaping @MainActor () -> any VoiceCapturing = { VoiceMicrophoneCapture() }
    ) {
        self.stash = stash
        self.preflight = preflight
        self.gestureConfig = gestureConfig
        self.makeCapture = makeCapture
    }

    /// Voice Input is available only when the app can reach the relay. Answered
    /// through the controller because that is the observed property; the
    /// capability itself is not, and a composer laid out before `attach` ran
    /// would otherwise never learn that dictation is reachable.
    public var isAvailable: Bool { controller != nil }

    // MARK: - Wiring

    /// Points the coordinator at one composer. Safe to call on every appearance
    /// and whenever the composer switches conversations: a transcript that
    /// finished while the old identity was active is delivered here.
    public func attach(
        identity: String,
        capability: (any FeatureVoiceTranscribing)?,
        readDraft: @escaping () -> String,
        writeDraft: @escaping (String) -> Void,
        readRange: @escaping (String) -> VoiceTextRange,
        moveCaret: @escaping (Int) -> Void
    ) {
        self.capability = capability
        self.readDraft = readDraft
        self.writeDraft = writeDraft
        self.readRange = readRange
        self.moveCaret = moveCaret
        let identityChanged = self.identity != identity
        self.identity = identity
        if controller == nil, capability != nil { makeController() }
        if let capability { preflight.prime(using: capability) }
        // Runs after the composer has settled on the new identity, so this never
        // fights an in-flight gesture on the previous one.
        if identityChanged { deliverStashedTranscript() }
    }

    /// Releases the touch bookkeeping for a composer that is going away.
    ///
    /// Deliberately does not stop the controller: a recording that outlives its
    /// composer is exactly the case the stash exists for, and SwiftUI does not
    /// guarantee that the outgoing view's `onDisappear` runs before the incoming
    /// one's `onAppear`, so a coordinator already re-pointed at another
    /// conversation must be left alone.
    public func detach(identity: String) {
        guard self.identity == identity else { return }
        holdTask?.cancel()
        holdTask = nil
        gestureState = .idle
        holdActive = false
        cancelArmed = false
        cancelProgress = 0
    }

    private func makeController() {
        let controller = VoiceInputController(
            capture: makeCapture(),
            transcribe: { [weak self] request in
                guard let capability = self?.capability else {
                    throw FeatureCapabilityUnavailable("Voice Input")
                }
                return try await capability.transcribeVoice(request)
            },
            onCompleted: { [weak self] outcome in
                self?.deliver(outcome.text)
            }
        )
        self.controller = controller
    }

    // MARK: - Transcript delivery

    private func deliver(_ transcript: String) {
        let draft = readDraft()
        let delivery = VoiceTranscriptInsertion.deliver(
            transcript: transcript,
            anchor: anchor,
            target: VoiceComposerTarget(
                identity: identity,
                draft: draft,
                range: readRange(draft)
            )
        )
        switch delivery {
        case .discarded:
            alert = VoiceComposerAlert(
                title: "Voice transcript discarded",
                message: "The composer changed during transcription.",
                kind: .notice
            )
        case let .stashed(stashIdentity, text):
            stash.put(identity: stashIdentity, text: text)
            alert = VoiceComposerAlert(
                title: "Voice transcript saved",
                message: "Switch back to that conversation to insert it.",
                kind: .notice
            )
        case let .inserted(result):
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            apply(result)
        }
    }

    private func deliverStashedTranscript() {
        guard let entry = stash.take(identity: identity) else { return }
        let draft = readDraft()
        apply(
            VoiceTranscriptInsertion.insert(
                draft: draft,
                range: readRange(draft),
                cleanedText: entry.text
            )
        )
    }

    private func apply(_ result: VoiceInsertionResult) {
        writeDraft(result.text)
        moveCaret(result.caret)
    }

    // MARK: - Recording

    private func captureAnchor() {
        let draft = readDraft()
        anchor = VoiceComposerAnchor(
            identity: identity,
            draft: draft,
            range: readRange(draft)
        )
    }

    /// Start when idle, stop when recording. Captures the anchor on both,
    /// because a recording that ends on its own — the duration cap, an
    /// interruption — still needs an insertion point.
    public func toggle() {
        guard let controller, let capability else {
            needsOpenRouter = false
            alert = VoiceComposerAlert(
                title: "Voice Input unavailable",
                message: "Sign in to your T3 account to dictate messages.",
                kind: .notice
            )
            return
        }
        captureAnchor()
        activeTask?.cancel()
        activeTask = Task { @MainActor [weak self] in
            guard let self else { return }
            if controller.state.isRecording {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                await controller.stop()
                return
            }
            guard controller.state.acceptsStart else { return }

            if let cached = self.preflight.read(), cached.isReady {
                self.preflight.prime(using: capability)
                await self.beginRecording(cleanup: cached.settings.cleanupEnabled)
                return
            }
            self.preflight.invalidate()
            do {
                let fresh = try await self.preflight.refresh(using: capability)
                guard fresh.isReady else {
                    self.needsOpenRouter = true
                    self.alert = VoiceComposerAlert(
                        title: "Connect OpenRouter",
                        message: "Voice Input transcribes through OpenRouter. "
                            + "Connect it in Settings › Voice Input.",
                        kind: .notice
                    )
                    return
                }
                await self.beginRecording(cleanup: fresh.settings.cleanupEnabled)
            } catch {
                self.needsOpenRouter = false
                self.alert = VoiceComposerAlert(
                    title: "Sign in to use Voice Input",
                    message: VoiceInputError(code: .unauthenticated).displayMessage,
                    kind: .notice
                )
            }
        }
    }

    private func beginRecording(cleanup: Bool) async {
        guard let controller else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        await controller.start(cleanup: cleanup)
        // The finger lifted while startup was still in flight (permission sheet,
        // preflight): honour the release now that there is something to stop.
        guard stopOnRecording else { return }
        stopOnRecording = false
        if controller.state.isRecording { await controller.stop() }
    }

    public func cancelRecording() {
        guard let controller else { return }
        activeTask?.cancel()
        activeTask = Task { @MainActor in
            await controller.cancel()
        }
    }

    public func retry() {
        guard let controller else { return }
        activeTask?.cancel()
        activeTask = Task { @MainActor in
            await controller.retry()
        }
    }

    public func setCleanup(_ cleanup: Bool) {
        controller?.setRecordingCleanup(cleanup)
    }

    // MARK: - Gesture

    public func press(y: Double, at time: Date = Date(), button: VoiceComboButtonAction) {
        dispatch(.press(at: time.timeIntervalSince1970 * 1_000, y: y), button: button)
        guard case .pressing = gestureState else { return }
        holdTask?.cancel()
        holdTask = Task { @MainActor [weak self, gestureConfig] in
            try? await Task.sleep(for: .milliseconds(gestureConfig.holdClassifyMilliseconds))
            guard !Task.isCancelled, let self else { return }
            self.holdTask = nil
            self.dispatch(.holdElapsed, button: button)
        }
    }

    public func move(y: Double, button: VoiceComboButtonAction) {
        dispatch(.move(y: y), button: button)
    }

    public func release(at time: Date = Date(), button: VoiceComboButtonAction) {
        dispatch(.release(at: time.timeIntervalSince1970 * 1_000), button: button)
    }

    /// The platform took the touch away (an ancestor recognizer claimed it).
    public func interrupt(button: VoiceComboButtonAction) {
        guard gestureState != .idle else { return }
        dispatch(.interrupt, button: button)
    }

    /// Plain activation for assistive technologies, which fire an action rather
    /// than a touch sequence.
    public func activate(button: VoiceComboButtonAction) {
        stopOnRecording = false
        if state.isRecording {
            toggle()
            return
        }
        if button.canSend {
            button.send()
            return
        }
        toggle()
    }

    private func dispatch(_ event: VoiceGestureEvent, button: VoiceComboButtonAction) {
        let transition = VoiceGestureMachine.transition(
            gestureState,
            event,
            config: gestureConfig
        )
        gestureState = transition.state
        if gestureState == .idle {
            holdTask?.cancel()
            holdTask = nil
        }
        for effect in transition.effects {
            apply(effect, button: button)
        }
        holdActive = gestureState.isHolding
        cancelArmed = gestureState.cancelArmed
        cancelProgress = (
            VoiceGestureMachine.cancelProgress(gestureState, config: gestureConfig) * 20
        ).rounded() / 20
    }

    private func apply(_ effect: VoiceGestureEffect, button: VoiceComboButtonAction) {
        switch effect {
        case .tap:
            stopOnRecording = false
            if state.isRecording {
                toggle()
            } else if button.canSend {
                button.send()
            } else {
                toggle()
            }

        case .holdClassified:
            holdOwnsSession = state.acceptsStart
            guard holdOwnsSession else { break }
            stopOnRecording = false
            toggle()

        case .stopAndTranscribe:
            if state.isRecording {
                toggle()
            } else {
                // Startup has not reached `recording` yet; remember the release
                // so `beginRecording` stops it the moment it does.
                stopOnRecording = true
            }

        case let .cancelRecording(reason):
            stopOnRecording = false
            if reason == .swipe {
                // The discard the swipe armed is now real; say so in the hand.
                UINotificationFeedbackGenerator().notificationOccurred(.warning)
            }
            if reason == .tooShort, !holdOwnsSession {
                // The hold grabbed a session it did not start: a graze-length
                // release means "stop", never "throw away what was already
                // being recorded".
                if state.isRecording { toggle() }
                break
            }
            if reason == .tooShort {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
            cancelRecording()

        case .cancelArmedChanged:
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }

    // MARK: - Failure surfacing

    /// One alert per failure: without this guard every state re-read while the
    /// state is still `failed` would stack duplicates. The composer calls it
    /// from `onChange(of:)` on the controller's state.
    public func surfaceFailureAlert() {
        guard case let .failed(stage, error, canRetry) = state else {
            alertedFailure = nil
            return
        }
        guard alertedFailure != state else { return }
        alertedFailure = state
        if stage == .permission {
            alert = error.permanent
                ? VoiceComposerAlert(
                    title: "Microphone permission required",
                    message: "Enable microphone access in system settings to use Voice Input.",
                    kind: .permissionBlocked
                )
                : VoiceComposerAlert(
                    title: "Microphone access needed",
                    message: "Allow microphone access to use Voice Input.",
                    kind: .permissionRetry
                )
            return
        }
        alert = VoiceComposerAlert(
            title: "Voice input failed",
            message: error.displayMessage,
            kind: canRetry ? .failureRetry : .notice
        )
    }
}
