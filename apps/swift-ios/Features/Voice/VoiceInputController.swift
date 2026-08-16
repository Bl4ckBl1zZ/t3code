import Foundation
import Observation

// Ported from the `VoiceInputController` class in
// packages/client-runtime/src/voice/index.ts.

public enum VoiceInputStage: Sendable, Equatable {
    case permission
    case recording
    case transcription
}

public enum VoiceInputState: Sendable, Equatable {
    case idle
    case requestingPermission
    case recording(startedAt: Date, cleanup: Bool)
    case stopping
    case transcribing(requestID: String)
    case completed(VoiceTranscriptionOutcome)
    case failed(stage: VoiceInputStage, error: VoiceInputError, canRetry: Bool)

    /// Something is in flight that the composer should not interrupt.
    public var isBusy: Bool {
        switch self {
        case .requestingPermission, .recording, .stopping, .transcribing: true
        case .idle, .completed, .failed: false
        }
    }

    public var isRecording: Bool {
        if case .recording = self { return true }
        return false
    }

    public var recordingStartedAt: Date? {
        if case let .recording(startedAt, _) = self { return startedAt }
        return nil
    }

    public var recordingCleanup: Bool {
        if case let .recording(_, cleanup) = self { return cleanup }
        return false
    }

    /// `completed` is a resting state — nothing resets it to idle — so it has to
    /// accept a fresh `start` exactly like `idle` and `failed` do. Excluding it
    /// is what left hold-to-record dead after the first successful dictation on
    /// mobile.
    var acceptsStart: Bool {
        switch self {
        case .idle, .completed, .failed: true
        case .requestingPermission, .recording, .stopping, .transcribing: false
        }
    }
}

public struct VoiceTranscriptionOutcome: Sendable, Equatable {
    public let requestID: String
    public let rawText: String
    public let text: String
    public let cleanupApplied: Bool
    public let warning: String?
}

/// Drives permission → capture → transcription and publishes one state for the
/// composer to render.
///
/// Every asynchronous leg is guarded by a generation counter: a `cancel` or a
/// second `start` bumps it, and a late permission grant or transcription reply
/// from a superseded run is dropped instead of resurrecting a dead session.
@MainActor
@Observable
public final class VoiceInputController {
    public typealias Transcribe = @MainActor (VoiceTranscriptionRequest) async throws
        -> VoiceTranscriptionResponse

    public private(set) var state: VoiceInputState = .idle
    /// 0...1 speech envelope, updated on the capture adapter's sampling cadence.
    public private(set) var level: Double = 0

    private let capture: any VoiceCapturing
    private let transcribe: Transcribe
    private let makeRequestID: @Sendable () -> String
    private let now: @MainActor () -> Date
    private let maximumDuration: Duration
    private let onCompleted: @MainActor (VoiceTranscriptionOutcome) -> Void

    private var generation = 0
    private var durationTask: Task<Void, Never>?
    private var transcriptionTask: Task<Void, Never>?
    private var recording: VoiceRecording?
    private var cleanup = true

    public init(
        capture: any VoiceCapturing,
        transcribe: @escaping Transcribe,
        onCompleted: @escaping @MainActor (VoiceTranscriptionOutcome) -> Void,
        makeRequestID: @escaping @Sendable () -> String = { UUID().uuidString },
        now: @escaping @MainActor () -> Date = { Date() },
        maximumDurationSeconds: Double = VoiceInputLimits.maximumDurationSeconds
    ) {
        self.capture = capture
        self.transcribe = transcribe
        self.onCompleted = onCompleted
        self.makeRequestID = makeRequestID
        self.now = now
        maximumDuration = .seconds(maximumDurationSeconds)
    }

    @discardableResult
    public func start(cleanup: Bool) async -> Bool {
        guard state.acceptsStart else { return false }
        await cancel()
        self.cleanup = cleanup
        generation += 1
        let generation = generation
        state = .requestingPermission

        let permission = await capture.requestPermission()
        guard generation == self.generation else {
            // A stale grant can leave the adapter holding a live microphone.
            await capture.cancel()
            return false
        }
        guard permission == .granted else {
            state = .failed(
                stage: .permission,
                error: VoiceInputError(
                    code: .permissionDenied,
                    permanent: permission == .blocked
                ),
                canRetry: permission != .blocked
            )
            return false
        }

        do {
            try await capture.start(
                onLevel: { [weak self] level in
                    guard let self, self.state.isRecording else { return }
                    self.level = level
                },
                onInterrupted: { [weak self] in
                    Task { @MainActor in await self?.stop() }
                }
            )
        } catch {
            await capture.cancel()
            guard generation == self.generation else { return false }
            state = .failed(
                stage: .recording,
                error: VoiceInputError(
                    code: .recordingFailed,
                    message: (error as? LocalizedError)?.errorDescription
                        ?? error.localizedDescription
                ),
                canRetry: false
            )
            return false
        }
        guard generation == self.generation else {
            await capture.cancel()
            return false
        }

        level = 0
        state = .recording(startedAt: now(), cleanup: cleanup)
        durationTask = Task { @MainActor [weak self, maximumDuration] in
            try? await Task.sleep(for: maximumDuration)
            guard !Task.isCancelled else { return }
            await self?.stop()
        }
        return true
    }

    @discardableResult
    public func stop() async -> Bool {
        guard state.isRecording else { return false }
        clearDurationTask()
        state = .stopping
        do {
            recording = try await capture.stop()
        } catch {
            state = .failed(
                stage: .recording,
                error: VoiceInputError(
                    code: .recordingFailed,
                    message: (error as? LocalizedError)?.errorDescription
                        ?? error.localizedDescription
                ),
                canRetry: false
            )
            return false
        }
        return await runTranscription()
    }

    /// Toggling cleanup mid-recording only affects the run in progress; the
    /// stored preference is untouched.
    @discardableResult
    public func setRecordingCleanup(_ cleanup: Bool) -> Bool {
        guard case let .recording(startedAt, current) = state, current != cleanup else {
            return false
        }
        self.cleanup = cleanup
        state = .recording(startedAt: startedAt, cleanup: cleanup)
        return true
    }

    @discardableResult
    public func retry() async -> Bool {
        guard case let .failed(stage, _, canRetry) = state, canRetry else { return false }
        // A permission failure leaves no recording behind, so the only
        // meaningful retry is a fresh start that re-requests access.
        if stage == .permission { return await start(cleanup: cleanup) }
        guard recording != nil else { return false }
        return await runTranscription()
    }

    public func cancel() async {
        generation += 1
        clearDurationTask()
        transcriptionTask?.cancel()
        transcriptionTask = nil
        // Release capture from every non-idle state: a pending permission
        // request or a failed start can still hold a live microphone stream even
        // though nothing is "recording".
        if state != .idle { await capture.cancel() }
        recording = nil
        level = 0
        state = .idle
    }

    private func runTranscription() async -> Bool {
        guard let recording else { return false }
        generation += 1
        let generation = generation
        let requestID = makeRequestID()
        state = .transcribing(requestID: requestID)

        let request = VoiceTranscriptionRequest(
            requestId: requestID,
            audio: VoiceTranscriptionRequest.Audio(
                data: recording.data.base64EncodedString(),
                format: recording.format
            ),
            cleanup: cleanup,
            durationSeconds: recording.durationSeconds
        )
        do {
            let response = try await transcribe(request)
            // A reply carrying another request's id belongs to a run this
            // controller already walked away from.
            guard generation == self.generation, response.requestId == requestID else {
                return false
            }
            self.recording = nil
            let outcome = VoiceTranscriptionOutcome(
                requestID: requestID,
                rawText: response.rawText,
                text: response.text,
                cleanupApplied: response.cleanupApplied,
                warning: response.warning
            )
            state = .completed(outcome)
            onCompleted(outcome)
            return true
        } catch {
            guard generation == self.generation else { return false }
            let voiceError = VoiceInputError.normalize(error)
            // The recording is only worth keeping when the failure is one a
            // retry could clear; otherwise it is dropped with the state.
            if !voiceError.isRetryable { self.recording = nil }
            state = .failed(
                stage: .transcription,
                error: voiceError,
                canRetry: voiceError.isRetryable
            )
            return false
        }
    }

    private func clearDurationTask() {
        durationTask?.cancel()
        durationTask = nil
    }
}
