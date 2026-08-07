import Foundation
import XCTest

@testable import T3Code

/// Ports packages/client-runtime/src/voice/index.test.ts, with the capture
/// adapter stubbed so the permission → record → transcribe sequence is testable
/// without a microphone.
@MainActor
final class VoiceInputControllerTests: XCTestCase {
    func testAFinishedRecordingIsUploadedAsSixteenKilohertzMonoPCMWAV() async throws {
        let samples = Data(count: 32_000)
        let capture = StubVoiceCapture(
            recording: VoiceRecording(
                data: VoiceWaveFile.file(samples: samples),
                format: .wav,
                durationSeconds: VoiceWaveFile.durationSeconds(dataByteCount: samples.count)
            )
        )
        let transcriber = StubTranscriber()
        let controller = makeController(capture: capture, transcriber: transcriber)

        await controller.start(cleanup: true)
        XCTAssertTrue(controller.state.isRecording)
        await controller.stop()

        let request = try XCTUnwrap(transcriber.requests.last)
        XCTAssertEqual(request.audio.format, .wav)
        XCTAssertEqual(request.cleanup, true)
        XCTAssertEqual(try XCTUnwrap(request.durationSeconds), 1, accuracy: 0.0001)

        // The bytes that leave the device are a real RIFF file, not a container
        // the transcription provider will refuse.
        let uploaded = try XCTUnwrap(Data(base64Encoded: request.audio.data))
        XCTAssertEqual(uploaded.count, VoiceWaveFile.headerByteCount + samples.count)
        XCTAssertEqual(String(decoding: uploaded.prefix(4), as: UTF8.self), "RIFF")
        XCTAssertEqual(String(decoding: uploaded[8..<12], as: UTF8.self), "WAVE")
        XCTAssertEqual(uploaded[24], 0x80, "16000 Hz, little-endian")
        XCTAssertEqual(uploaded[25], 0x3E)
        XCTAssertEqual(uploaded[22], 1, "mono")
        XCTAssertEqual(uploaded[34], 16, "16-bit samples")
    }

    func testACompletedTranscriptionResolvesToTheCleanedText() async {
        let capture = StubVoiceCapture()
        let transcriber = StubTranscriber(
            response: VoiceTranscriptionResponse(
                requestId: "request-1",
                rawText: "ship the fix uh today",
                text: "Ship the fix today.",
                cleanupApplied: true
            )
        )
        var completed: [String] = []
        let controller = makeController(
            capture: capture,
            transcriber: transcriber,
            onCompleted: { completed.append($0.text) }
        )

        await controller.start(cleanup: true)
        await controller.stop()

        XCTAssertEqual(completed, ["Ship the fix today."])
        XCTAssertEqual(controller.state, .completed(
            VoiceTranscriptionOutcome(
                requestID: "request-1",
                rawText: "ship the fix uh today",
                text: "Ship the fix today.",
                cleanupApplied: true,
                warning: nil
            )
        ))
    }

    /// `completed` is a resting state — nothing resets it to idle — so it has to
    /// accept a fresh start. Treating it as terminal left hold-to-record dead
    /// after the first successful dictation on mobile.
    func testASecondRecordingStartsFromTheCompletedState() async {
        let capture = StubVoiceCapture()
        let controller = makeController(capture: capture, transcriber: StubTranscriber())

        await controller.start(cleanup: true)
        await controller.stop()
        guard case .completed = controller.state else {
            return XCTFail("Expected the first dictation to complete.")
        }

        let started = await controller.start(cleanup: true)

        XCTAssertTrue(started)
        XCTAssertTrue(controller.state.isRecording)
    }

    func testADeniedPermissionFailsRetryablyAndABlockedOneDoesNot() async {
        let denied = StubVoiceCapture()
        denied.permission = .denied
        let deniedController = makeController(capture: denied, transcriber: StubTranscriber())
        await deniedController.start(cleanup: true)
        XCTAssertEqual(
            deniedController.state,
            .failed(
                stage: .permission,
                error: VoiceInputError(code: .permissionDenied, permanent: false),
                canRetry: true
            )
        )

        let blocked = StubVoiceCapture()
        blocked.permission = .blocked
        let blockedController = makeController(capture: blocked, transcriber: StubTranscriber())
        await blockedController.start(cleanup: true)
        XCTAssertEqual(
            blockedController.state,
            .failed(
                stage: .permission,
                error: VoiceInputError(code: .permissionDenied, permanent: true),
                canRetry: false
            )
        )
    }

    /// Cancelling has to release the adapter from every non-idle state: a
    /// pending permission request or a failed start can still hold a live
    /// microphone stream even though nothing is "recording".
    func testCancellingReleasesTheMicrophoneAndReturnsToIdle() async {
        let capture = StubVoiceCapture()
        let controller = makeController(capture: capture, transcriber: StubTranscriber())

        await controller.start(cleanup: true)
        await controller.cancel()

        XCTAssertEqual(controller.state, .idle)
        XCTAssertEqual(capture.cancelCount, 1)
    }

    func testARetryableFailureKeepsTheRecordingAndResendsIt() async {
        let capture = StubVoiceCapture()
        let transcriber = StubTranscriber()
        transcriber.error = VoiceInputError(code: .rateLimited)
        let controller = makeController(capture: capture, transcriber: transcriber)

        await controller.start(cleanup: true)
        await controller.stop()
        XCTAssertEqual(
            controller.state,
            .failed(
                stage: .transcription,
                error: VoiceInputError(code: .rateLimited),
                canRetry: true
            )
        )

        transcriber.error = nil
        let retried = await controller.retry()

        XCTAssertTrue(retried)
        XCTAssertEqual(transcriber.requests.count, 2, "The recording is resent, not re-captured.")
        XCTAssertEqual(capture.stopCount, 1)
    }

    func testANonRetryableFailureDropsTheRecording() async {
        let capture = StubVoiceCapture()
        let transcriber = StubTranscriber()
        transcriber.error = VoiceInputError(code: .noSpeech)
        let controller = makeController(capture: capture, transcriber: transcriber)

        await controller.start(cleanup: true)
        await controller.stop()

        XCTAssertEqual(
            controller.state,
            .failed(
                stage: .transcription,
                error: VoiceInputError(code: .noSpeech),
                canRetry: false
            )
        )
        let retried = await controller.retry()
        XCTAssertFalse(retried, "A dropped recording has nothing to resend.")
    }

    /// A reply carrying another request's id belongs to a run the controller
    /// already walked away from.
    func testAResponseForAnotherRequestIsIgnored() async {
        let capture = StubVoiceCapture()
        let transcriber = StubTranscriber(
            response: VoiceTranscriptionResponse(
                requestId: "someone-else",
                rawText: "stale",
                text: "stale",
                cleanupApplied: false
            )
        )
        var completed: [String] = []
        let controller = makeController(
            capture: capture,
            transcriber: transcriber,
            onCompleted: { completed.append($0.text) }
        )

        await controller.start(cleanup: true)
        await controller.stop()

        XCTAssertTrue(completed.isEmpty)
        if case .completed = controller.state {
            XCTFail("A mismatched request id must not resolve the dictation.")
        }
    }

    func testCleanupCanBeToggledOnlyWhileRecording() async {
        let capture = StubVoiceCapture()
        let transcriber = StubTranscriber()
        let controller = makeController(capture: capture, transcriber: transcriber)

        XCTAssertFalse(controller.setRecordingCleanup(false))

        await controller.start(cleanup: true)
        XCTAssertTrue(controller.setRecordingCleanup(false))
        XCTAssertFalse(controller.state.recordingCleanup)
        await controller.stop()

        XCTAssertEqual(transcriber.requests.last?.cleanup, false)
    }

    private func makeController(
        capture: StubVoiceCapture,
        transcriber: StubTranscriber,
        onCompleted: @escaping @MainActor (VoiceTranscriptionOutcome) -> Void = { _ in }
    ) -> VoiceInputController {
        VoiceInputController(
            capture: capture,
            transcribe: { request in try await transcriber.transcribe(request) },
            onCompleted: onCompleted,
            makeRequestID: { "request-1" },
            now: { Date(timeIntervalSince1970: 0) }
        )
    }
}

@MainActor
private final class StubVoiceCapture: VoiceCapturing {
    var permission: VoiceCapturePermission = .granted
    var startError: (any Error)?
    private(set) var cancelCount = 0
    private(set) var stopCount = 0
    private let recording: VoiceRecording

    init(recording: VoiceRecording = VoiceRecording(
        data: VoiceWaveFile.file(samples: Data(count: 3_200)),
        format: .wav,
        durationSeconds: 0.1
    )) {
        self.recording = recording
    }

    func requestPermission() async -> VoiceCapturePermission { permission }

    func start(
        onLevel: @escaping @MainActor (Double) -> Void,
        onInterrupted: @escaping @MainActor () -> Void
    ) async throws {
        if let startError { throw startError }
    }

    func stop() async throws -> VoiceRecording {
        stopCount += 1
        return recording
    }

    func cancel() async {
        cancelCount += 1
    }
}

@MainActor
private final class StubTranscriber {
    var response: VoiceTranscriptionResponse?
    var error: (any Error)?
    private(set) var requests: [VoiceTranscriptionRequest] = []

    init(response: VoiceTranscriptionResponse? = nil) {
        self.response = response
    }

    func transcribe(
        _ request: VoiceTranscriptionRequest
    ) async throws -> VoiceTranscriptionResponse {
        requests.append(request)
        if let error { throw error }
        return response ?? VoiceTranscriptionResponse(
            requestId: request.requestId,
            rawText: "raw",
            text: "raw",
            cleanupApplied: request.cleanup ?? false
        )
    }
}
