import Foundation
import Observation
import XCTest

@testable import T3Code

/// The off-screen dictation pill (upstream bf5c146be9): when it shows, what it
/// offers, and that a transcript finishing behind it comes back to the
/// composer it was recorded in.
@MainActor
final class VoiceEdgePillTests: XCTestCase {
    private let startedAt = Date(timeIntervalSince1970: 100)

    // MARK: - Presentation

    func testThePillShowsOnlyWhileRecordingWithNoComposerOnScreen() {
        let recording = VoiceInputState.recording(startedAt: startedAt, cleanup: false)

        XCTAssertNil(resolve(recording, hasVisibleComposer: true), "the composer's own strip shows it")
        XCTAssertEqual(resolve(recording, hasVisibleComposer: false)?.startedAt, startedAt)
        for state: VoiceInputState in [.idle, .requestingPermission, .stopping, .transcribing(requestID: "r")] {
            XCTAssertNil(resolve(state, hasVisibleComposer: false), "\(state)")
        }
    }

    func testThePillIgnoresTouchesDuringAPushToTalkHold() {
        let recording = VoiceInputState.recording(startedAt: startedAt, cleanup: false)
        XCTAssertEqual(resolve(recording, holdActive: true)?.acceptsTouches, false)
        XCTAssertEqual(resolve(recording, holdActive: false)?.acceptsTouches, true)
    }

    func testReturnIsOfferedOnlyForAThreadThatStillExists() {
        let recording = VoiceInputState.recording(startedAt: startedAt, cleanup: false)
        XCTAssertEqual(resolve(recording, threadID: "thread-1", known: ["thread-1"])?.returnThreadID, "thread-1")
        XCTAssertNil(resolve(recording, threadID: "thread-gone", known: ["thread-1"])?.returnThreadID)
        // A compose sheet has no thread to go back to; the pill still stops.
        XCTAssertNotNil(resolve(recording, threadID: nil, known: ["thread-1"]))
        XCTAssertNil(resolve(recording, threadID: nil, known: ["thread-1"])?.returnThreadID)
    }

    func testLevelBarsStayWithinTheirBoundsAndRiseWithTheLevel() {
        let silent = VoiceEdgePillLevels.heights(level: 0)
        let loud = VoiceEdgePillLevels.heights(level: 1)
        XCTAssertEqual(silent, Array(repeating: VoiceEdgePillLevels.minimumHeight, count: silent.count))
        XCTAssertEqual(loud.max(), VoiceEdgePillLevels.maximumHeight)
        XCTAssertEqual(VoiceEdgePillLevels.heights(level: 4), loud, "levels clamp")
        XCTAssertTrue(zip(VoiceEdgePillLevels.heights(level: 0.3), loud).allSatisfy { $0 <= $1 })
    }

    // MARK: - Coordinator visibility

    func testVisibilityFollowsComposersRegardlessOfAppearanceOrder() {
        let voice = VoiceComposerCoordinator(stash: VoiceTranscriptStash(), preflight: VoicePreflightCache())
        let outgoing = UUID()
        let incoming = UUID()
        XCTAssertFalse(voice.hasVisibleComposer)

        attach(voice, identity: "thread-1", composer: outgoing)
        XCTAssertTrue(voice.hasVisibleComposer)
        // SwiftUI may bring the replacement composer up before the old one
        // goes, even for the same conversation.
        attach(voice, identity: "thread-1", composer: incoming)
        voice.detach(identity: "thread-1", composer: outgoing)
        XCTAssertTrue(voice.hasVisibleComposer)

        voice.detach(identity: "thread-1", composer: incoming)
        XCTAssertFalse(voice.hasVisibleComposer)
    }

    func testReturningToTheSameComposerTakesBackItsStashedTranscript() {
        let stash = VoiceTranscriptStash()
        let voice = VoiceComposerCoordinator(stash: stash, preflight: VoicePreflightCache())
        var draft = "Draft"
        let composer = UUID()
        attach(voice, identity: "thread-1", composer: composer, draft: { draft }, write: { draft = $0 })
        voice.detach(identity: "thread-1", composer: composer)

        // Finished while the pill was the only thing on screen.
        stash.put(identity: "thread-1", text: "spoken words")
        attach(voice, identity: "thread-1", composer: UUID(), draft: { draft }, write: { draft = $0 })

        XCTAssertEqual(draft, "Draft spoken words")
        XCTAssertNil(stash.peek(identity: "thread-1"))
    }

    /// A thread view restores its saved draft after the composer attaches; a
    /// transcript written in before that would be replaced by the restore.
    func testAStashedTranscriptWaitsForTheRestoredDraft() {
        let stash = VoiceTranscriptStash()
        let voice = VoiceComposerCoordinator(stash: stash, preflight: VoicePreflightCache())
        var draft = ""
        stash.put(identity: "thread-1", text: "spoken words")

        attach(voice, identity: "thread-1", composer: UUID(), draftLoaded: false, draft: { draft }, write: { draft = $0 })
        XCTAssertEqual(draft, "", "held back while the saved draft is still loading")
        XCTAssertNotNil(stash.peek(identity: "thread-1"))

        draft = "Restored draft"
        voice.draftDidLoad(identity: "thread-1")
        XCTAssertEqual(draft, "Restored draft spoken words")
        XCTAssertNil(stash.peek(identity: "thread-1"))
    }

    func testARecordingFinishedOffScreenIsStashedForItsThreadNotWrittenIntoAGoneDraft() async throws {
        let stash = VoiceTranscriptStash()
        let preflight = VoicePreflightCache()
        let capability = StubVoiceCapability(transcript: "Ship it.")
        _ = try await preflight.refresh(using: capability)
        let voice = VoiceComposerCoordinator(
            stash: stash,
            preflight: preflight,
            makeCapture: { SilentVoiceCapture() }
        )
        var draft = ""
        var writes = 0
        let composer = UUID()
        attach(
            voice,
            identity: "thread-1",
            composer: composer,
            threadID: "thread-1",
            capability: capability,
            draft: { draft },
            write: { draft = $0; writes += 1 }
        )

        voice.toggle()
        await waitUntil { voice.state.isRecording }
        XCTAssertEqual(voice.recordingThreadID, "thread-1")

        voice.detach(identity: "thread-1", composer: composer)
        voice.stopOffScreen()
        await waitUntil { if case .completed = voice.state { true } else { false } }

        XCTAssertEqual(writes, 0, "the detached composer's draft is never written")
        XCTAssertEqual(stash.peek(identity: "thread-1")?.text, "Ship it.")

        attach(
            voice,
            identity: "thread-1",
            composer: UUID(),
            threadID: "thread-1",
            capability: capability,
            draft: { draft },
            write: { draft = $0; writes += 1 }
        )
        XCTAssertEqual(draft, "Ship it.")
    }

    // MARK: - Helpers

    private func resolve(
        _ state: VoiceInputState,
        hasVisibleComposer: Bool = false,
        holdActive: Bool = false,
        threadID: String? = nil,
        known: Set<String> = []
    ) -> VoiceEdgePillPresentation? {
        VoiceEdgePillPresentation.resolve(
            state: state,
            hasVisibleComposer: hasVisibleComposer,
            holdActive: holdActive,
            recordingThreadID: threadID,
            threadExists: { known.contains($0) }
        )
    }

    private func attach(
        _ voice: VoiceComposerCoordinator,
        identity: String,
        composer: UUID,
        threadID: String? = nil,
        draftLoaded: Bool = true,
        capability: (any FeatureVoiceTranscribing)? = nil,
        draft: @escaping () -> String = { "" },
        write: @escaping (String) -> Void = { _ in }
    ) {
        voice.attach(
            identity: identity,
            composer: composer,
            threadID: threadID,
            draftLoaded: draftLoaded,
            capability: capability,
            readDraft: draft,
            writeDraft: write,
            readRange: { VoiceTextRange(caret: $0.utf16.count) },
            moveCaret: { _ in }
        )
    }

    /// Resumes on the next observed change until `condition` holds; no sleeps.
    private func waitUntil(_ condition: @escaping @MainActor () -> Bool) async {
        while !condition() {
            await withCheckedContinuation { continuation in
                withObservationTracking {
                    _ = condition()
                } onChange: {
                    continuation.resume()
                }
            }
        }
    }
}

@MainActor
private final class SilentVoiceCapture: VoiceCapturing {
    func requestPermission() async -> VoiceCapturePermission { .granted }

    func start(
        onLevel: @escaping @MainActor (Double) -> Void,
        onInterrupted: @escaping @MainActor () -> Void
    ) async throws {}

    func stop() async throws -> VoiceRecording {
        VoiceRecording(
            data: VoiceWaveFile.file(samples: Data(count: 3_200)),
            format: .wav,
            durationSeconds: 0.1
        )
    }

    func cancel() async {}
}

@MainActor
private final class StubVoiceCapability: FeatureVoiceTranscribing {
    private let transcript: String

    init(transcript: String) {
        self.transcript = transcript
    }

    func openRouterIntegration() async throws -> OpenRouterIntegrationStatus {
        OpenRouterIntegrationStatus(configured: true, state: .connected)
    }

    func putOpenRouterCredential(apiKey _: String) async throws -> OpenRouterIntegrationStatus {
        try await openRouterIntegration()
    }

    func validateOpenRouterCredential() async throws -> OpenRouterIntegrationStatus {
        try await openRouterIntegration()
    }

    func deleteOpenRouterCredential() async throws -> OpenRouterIntegrationStatus {
        OpenRouterIntegrationStatus()
    }

    func voiceInputSettings() async throws -> VoiceInputSettings {
        VoiceInputSettings(cleanupEnabled: false)
    }

    func patchVoiceInputSettings(_: VoiceInputSettingsPatch) async throws -> VoiceInputSettings {
        VoiceInputSettings(cleanupEnabled: false)
    }

    func listOpenRouterAudioModels() async throws -> [OpenRouterModelOption] { [] }

    func transcribeVoice(_ request: VoiceTranscriptionRequest) async throws -> VoiceTranscriptionResponse {
        VoiceTranscriptionResponse(
            requestId: request.requestId,
            rawText: transcript,
            text: transcript,
            cleanupApplied: false
        )
    }
}
