import Foundation
import XCTest
@testable import T3Code

// Voice Input is account state on the T3 Connect relay, not environment state,
// so these assert the relay contract in packages/contracts/src/relay.ts rather
// than an orchestration RPC. The token provider is injected, which is what lets
// the wire shapes be checked without a Clerk session.
@MainActor
final class NativeVoiceRelayTests: XCTestCase {
    func testIntegrationEndpointsMatchTheRelayContract() async throws {
        let transport = VoiceRelayTransport(
            responses: [
                "/v1/client/integrations/openrouter": """
                {"configured":true,"credentialHint":"…9f2","state":"connected",
                 "lastValidatedAt":"2026-08-01T09:00:00.000Z"}
                """,
                "/v1/client/integrations/openrouter/credential": """
                {"configured":true,"state":"validating"}
                """,
                "/v1/client/integrations/openrouter/validate": """
                {"configured":true,"state":"connected"}
                """,
            ]
        )
        let relay = makeRelay(transport)

        let status = try await relay.openRouterIntegration()
        XCTAssertTrue(status.configured)
        XCTAssertEqual(status.state, .connected)
        XCTAssertEqual(status.credentialHint, "…9f2")
        XCTAssertTrue(status.isConnected)

        _ = try await relay.putOpenRouterCredential(apiKey: "sk-or-secret")
        _ = try await relay.validateOpenRouterCredential()
        _ = try await relay.deleteOpenRouterCredential()

        let requests = await transport.requests()
        XCTAssertEqual(
            requests.map { "\($0.method) \($0.path)" },
            [
                "GET /v1/client/integrations/openrouter",
                "PUT /v1/client/integrations/openrouter/credential",
                "POST /v1/client/integrations/openrouter/validate",
                "DELETE /v1/client/integrations/openrouter/credential",
            ]
        )
        XCTAssertEqual(
            Set(requests.map(\.authorization)),
            ["Bearer clerk-token"]
        )
        let credential = try XCTUnwrap(requests[1].body)
        XCTAssertEqual(credential["apiKey"]?.stringValue, "sk-or-secret")
    }

    func testVoiceSettingsFlattenTheNestedCleanupToggle() async throws {
        let transport = VoiceRelayTransport(
            responses: [
                "/v1/client/preferences/voice-input": """
                {
                  "model": "google/gemini-2.5-flash",
                  "language": null,
                  "cleanup": {"enabled": false},
                  "dictionary": ["T3", "Hermes"]
                }
                """,
            ]
        )
        let relay = makeRelay(transport)

        let settings = try await relay.voiceInputSettings()
        XCTAssertEqual(settings.model, "google/gemini-2.5-flash")
        XCTAssertNil(settings.language)
        XCTAssertFalse(settings.cleanupEnabled)
        XCTAssertEqual(settings.dictionary, ["T3", "Hermes"])

        _ = try await relay.patchVoiceInputSettings(
            VoiceInputSettingsPatch(cleanupEnabled: true)
        )
        let requests = await transport.requests()
        XCTAssertEqual(requests.last?.method, "PATCH")
        XCTAssertEqual(requests.last?.path, "/v1/client/preferences/voice-input")
        XCTAssertEqual(requests.last?.body?["cleanup"]?["enabled"], JSONValue.bool(true))
    }

    /// `language` has three wire states and only two of them are expressible as
    /// an `Optional<String>`: absent leaves the stored value alone, explicit
    /// null asks the transcriber to detect the language.
    func testPatchOnlyCarriesTheFieldsThatChanged() {
        let untouched = NativeVoiceRelayClient.patchPayload(VoiceInputSettingsPatch())
        XCTAssertEqual(untouched, JSONValue.object([:]))

        let automatic = NativeVoiceRelayClient.patchPayload(
            VoiceInputSettingsPatch(model: "openai/whisper", language: .automatic)
        )
        XCTAssertEqual(automatic["model"]?.stringValue, "openai/whisper")
        XCTAssertEqual(automatic["language"], JSONValue.null)
        XCTAssertNil(automatic["cleanup"])
        XCTAssertNil(automatic["dictionary"])

        let explicit = NativeVoiceRelayClient.patchPayload(
            VoiceInputSettingsPatch(language: .explicit("de"), dictionary: ["T3"])
        )
        XCTAssertEqual(explicit["language"]?.stringValue, "de")
        XCTAssertEqual(explicit["dictionary"], JSONValue.array([.string("T3")]))
        XCTAssertNil(explicit["model"])
    }

    func testAudioModelListingAsksForTheAudioCapability() async throws {
        let transport = VoiceRelayTransport(
            responses: [
                "/v1/client/integrations/openrouter/models": """
                {
                  "models": [
                    {
                      "id": "google/gemini-2.5-flash",
                      "name": "Gemini 2.5 Flash",
                      "providerName": "Google",
                      "capability": "audio",
                      "available": true
                    },
                    {
                      "id": "openai/whisper-1",
                      "name": "Whisper",
                      "providerName": "OpenAI",
                      "capability": "audio",
                      "available": false
                    }
                  ]
                }
                """,
            ]
        )
        let relay = makeRelay(transport)

        let models = try await relay.listOpenRouterModels(capability: "audio")
        XCTAssertEqual(models.map(\.id), ["google/gemini-2.5-flash", "openai/whisper-1"])
        // A model the account cannot currently call still lists, so a selection
        // made on another client stays visible.
        XCTAssertEqual(models.last?.subtitle, "OpenAI · Unavailable")

        let requests = await transport.requests()
        XCTAssertEqual(requests.last?.query, "capability=audio")
    }

    func testRelayFailuresCarryTheServersMessageAndTrace() async throws {
        let transport = VoiceRelayTransport(
            responses: [:],
            status: 402,
            failureBody: #"""
            {"message":"Add credit to your OpenRouter account.","traceId":"trace-9"}
            """#
        )
        let relay = makeRelay(transport)

        do {
            _ = try await relay.validateOpenRouterCredential()
            XCTFail("A rejected relay call must not read as success.")
        } catch let error as T3ConnectRelayError {
            XCTAssertEqual(
                error.errorDescription,
                "Add credit to your OpenRouter account. (trace trace-9)"
            )
        }
    }

    /// The audio has no upload endpoint of its own: it rides inline as base64 on
    /// the transcription POST, which is why the request shape is pinned here.
    func testTranscriptionPostsTheAudioInlineAndEchoesTheRequestID() async throws {
        let transport = VoiceRelayTransport(
            responses: [
                "/v1/client/voice/transcriptions": """
                {
                  "requestId": "req-1",
                  "rawText": "ship the fix uh today",
                  "text": "Ship the fix today.",
                  "cleanupApplied": true
                }
                """,
            ]
        )
        let relay = makeRelay(transport)

        let response = try await relay.transcribeVoice(
            VoiceTranscriptionRequest(
                requestId: "req-1",
                audio: VoiceTranscriptionRequest.Audio(data: "UklGRg==", format: .wav),
                cleanup: true,
                durationSeconds: 2.5
            )
        )

        XCTAssertEqual(response.requestId, "req-1")
        XCTAssertEqual(response.rawText, "ship the fix uh today")
        XCTAssertEqual(response.text, "Ship the fix today.")
        XCTAssertTrue(response.cleanupApplied)

        let recorded = await transport.requests()
        let request = try XCTUnwrap(recorded.last)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/v1/client/voice/transcriptions")
        XCTAssertEqual(request.authorization, "Bearer clerk-token")
        let body = try XCTUnwrap(request.body)
        XCTAssertEqual(body["requestId"]?.stringValue, "req-1")
        XCTAssertEqual(body["audio"]?["data"]?.stringValue, "UklGRg==")
        // iOS records PCM WAV because providers reject its native AAC/m4a.
        XCTAssertEqual(body["audio"]?["format"]?.stringValue, "wav")
        XCTAssertEqual(body["cleanup"], JSONValue.bool(true))
    }

    /// Optional keys are absent rather than null: the contract spells them
    /// `optionalKey`, and an explicit null fails validation.
    func testOptionalTranscriptionFieldsAreOmittedWhenUnset() async throws {
        let transport = VoiceRelayTransport(
            responses: [
                "/v1/client/voice/transcriptions": """
                {"requestId":"req-2","rawText":"hi","text":"hi","cleanupApplied":false}
                """,
            ]
        )
        let relay = makeRelay(transport)

        _ = try await relay.transcribeVoice(
            VoiceTranscriptionRequest(
                requestId: "req-2",
                audio: VoiceTranscriptionRequest.Audio(data: "AAAA", format: .wav)
            )
        )

        let recorded = await transport.requests()
        let body = try XCTUnwrap(recorded.last?.body)
        XCTAssertNil(body["cleanup"])
        XCTAssertNil(body["durationSeconds"])
    }

    /// The composer branches on the code — no speech, rate limited, needs credit
    /// — so a rejection has to arrive as that code rather than as prose.
    func testARejectedTranscriptionCarriesItsMachineReadableCode() async throws {
        let transport = VoiceRelayTransport(
            responses: [:],
            status: 400,
            failureBody: #"""
            {"_tag":"RelayVoiceInputError","code":"no_speech","traceId":"trace-4"}
            """#
        )
        let relay = makeRelay(transport)

        do {
            _ = try await relay.transcribeVoice(
                VoiceTranscriptionRequest(
                    requestId: "req-3",
                    audio: VoiceTranscriptionRequest.Audio(data: "AAAA", format: .wav)
                )
            )
            XCTFail("A rejected transcription must not read as success.")
        } catch let error as VoiceInputError {
            XCTAssertEqual(error.code, .noSpeech)
            XCTAssertEqual(error.displayMessage, "No speech was detected in the recording.")
            XCTAssertFalse(error.isRetryable)
        }
    }

    func testARetryableRejectionKeepsTheRecordingWorthResending() {
        let rateLimited = NativeVoiceRelayClient.voiceError(
            from: Data(#"{"code":"rate_limited","traceId":"t","retryAfterSeconds":30}"#.utf8)
        )
        XCTAssertEqual(rateLimited?.code, .rateLimited)
        XCTAssertEqual(rateLimited?.isRetryable, true)

        let providerDetail = NativeVoiceRelayClient.voiceError(
            from: Data(#"{"code":"invalid_audio","traceId":"t","detail":"bad header"}"#.utf8)
        )
        XCTAssertEqual(providerDetail?.code, .invalidAudio)
        XCTAssertEqual(
            providerDetail?.displayMessage,
            "The recording could not be processed: bad header"
        )

        // An unknown code stays nil so the caller falls back to the generic
        // relay error instead of inventing a category.
        XCTAssertNil(
            NativeVoiceRelayClient.voiceError(from: Data(#"{"code":"teapot"}"#.utf8))
        )
    }

    /// A recording longer than the cap could never encode under 12 MB, and
    /// discovering that from the server would waste the whole upload.
    func testOversizedAudioIsRejectedBeforeTheRequestIsBuilt() async {
        let transport = VoiceRelayTransport(responses: [:])
        let relay = makeRelay(transport)

        do {
            _ = try await relay.transcribeVoice(
                VoiceTranscriptionRequest(
                    requestId: "req-4",
                    audio: VoiceTranscriptionRequest.Audio(
                        data: String(
                            repeating: "A",
                            count: VoiceInputLimits.maximumAudioBytes + 1
                        ),
                        format: .wav
                    )
                )
            )
            XCTFail("Audio over the contract cap must not be uploaded.")
        } catch let error as VoiceInputError {
            XCTAssertEqual(error.code, .audioTooLarge)
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
        let requests = await transport.requests()
        XCTAssertTrue(requests.isEmpty, "Nothing should reach the network.")
    }

    private func makeRelay(_ transport: VoiceRelayTransport) -> NativeVoiceRelayClient {
        NativeVoiceRelayClient(
            baseURL: URL(string: "https://relay.example")!,
            transport: transport
        ) { "clerk-token" }
    }
}

private struct VoiceRelayRequest: Sendable {
    let method: String
    let path: String
    let query: String?
    let authorization: String?
    let body: JSONValue?
}

private actor VoiceRelayTransport: HTTPTransport {
    private let responses: [String: String]
    private let status: Int
    private let failureBody: String
    private var recorded: [VoiceRelayRequest] = []

    init(
        responses: [String: String],
        status: Int = 200,
        failureBody: String = "{}"
    ) {
        self.responses = responses
        self.status = status
        self.failureBody = failureBody
    }

    func requests() -> [VoiceRelayRequest] {
        recorded
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)
        recorded.append(
            VoiceRelayRequest(
                method: request.httpMethod ?? "GET",
                path: components?.path ?? "",
                query: components?.query,
                authorization: request.value(forHTTPHeaderField: "Authorization"),
                body: request.httpBody.flatMap {
                    try? JSONDecoder.t3.decode(JSONValue.self, from: $0)
                }
            )
        )
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        guard (200..<300).contains(status) else {
            return (Data(failureBody.utf8), response)
        }
        let body = responses[components?.path ?? ""]
            ?? #"{"configured":false,"state":"not_configured"}"#
        return (Data(body.utf8), response)
    }
}
