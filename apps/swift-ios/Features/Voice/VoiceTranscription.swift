import Foundation

// Ported from packages/contracts/src/voice.ts (the transcription half; the
// settings half already lives in Features/Settings/SettingsVoiceService.swift)
// and packages/client-runtime/src/voice/index.ts.

public enum VoiceInputLimits {
    /// `VOICE_INPUT_MAX_AUDIO_BYTES`. 16 kHz mono 16-bit PCM runs 32 kB/s, so a
    /// full-length recording lands near 3.8 MB and never approaches this.
    public static let maximumAudioBytes = 12 * 1024 * 1024
    /// `VOICE_INPUT_MAX_DURATION_SECONDS`.
    public static let maximumDurationSeconds = 120.0
}

public enum VoiceAudioFormat: String, Codable, Sendable, Equatable, CaseIterable {
    case webm
    case m4a
    case wav
    case mp3
    case ogg
    case aac
}

public struct VoiceTranscriptionRequest: Codable, Sendable, Equatable {
    public struct Audio: Codable, Sendable, Equatable {
        /// Bare base64 — no `data:` URL prefix. The relay decodes it directly.
        public let data: String
        public let format: VoiceAudioFormat

        public init(data: String, format: VoiceAudioFormat) {
            self.data = data
            self.format = format
        }
    }

    /// Idempotency key. The response echoes it, and a reply carrying a
    /// different one belongs to a request this client already walked away from.
    public let requestId: String
    public let audio: Audio
    public let cleanup: Bool?
    public let durationSeconds: Double?

    public init(
        requestId: String,
        audio: Audio,
        cleanup: Bool? = nil,
        durationSeconds: Double? = nil
    ) {
        self.requestId = requestId
        self.audio = audio
        self.cleanup = cleanup
        self.durationSeconds = durationSeconds
    }
}

public struct VoiceTranscriptionResponse: Codable, Sendable, Equatable {
    public struct Usage: Codable, Sendable, Equatable {
        public let audioSeconds: Double?
        public let costUsd: Double?
    }

    public let requestId: String
    /// The transcriber's output before the optional cleanup pass.
    public let rawText: String
    /// What the composer inserts: cleaned when cleanup ran, `rawText` otherwise.
    public let text: String
    public let cleanupApplied: Bool
    public let warning: String?
    public let usage: Usage?

    public init(
        requestId: String,
        rawText: String,
        text: String,
        cleanupApplied: Bool,
        warning: String? = nil,
        usage: Usage? = nil
    ) {
        self.requestId = requestId
        self.rawText = rawText
        self.text = text
        self.cleanupApplied = cleanupApplied
        self.warning = warning
        self.usage = usage
    }
}

/// `VoiceTranscriptionErrorCode` plus the two failures that never reach the
/// relay because they happen on the device.
public enum VoiceInputErrorCode: String, Codable, Sendable, Equatable, CaseIterable {
    case permissionDenied = "permission_denied"
    case recordingFailed = "recording_failed"
    case unauthenticated
    case integrationNotConfigured = "integration_not_configured"
    case credentialInvalid = "credential_invalid"
    case invalidAudio = "invalid_audio"
    case audioTooLarge = "audio_too_large"
    case durationExceeded = "duration_exceeded"
    case noSpeech = "no_speech"
    case unsupportedFormat = "unsupported_format"
    case modelUnavailable = "model_unavailable"
    case rateLimited = "rate_limited"
    case providerPaymentRequired = "provider_payment_required"
    case transcriptionFailed = "transcription_failed"
    case requestAborted = "request_aborted"
}

public struct VoiceInputError: Error, Sendable, Equatable {
    public let code: VoiceInputErrorCode
    public let message: String?
    /// A denial the app cannot re-ask for: only system settings can undo it.
    public let permanent: Bool

    public init(code: VoiceInputErrorCode, message: String? = nil, permanent: Bool = false) {
        self.code = code
        self.message = message
        self.permanent = permanent
    }

    /// `RETRYABLE_ERRORS` from the shared controller: the recording is still on
    /// hand, so the transcription can be re-sent without asking the user to
    /// speak again.
    public var isRetryable: Bool {
        switch code {
        case .rateLimited, .transcriptionFailed, .modelUnavailable: true
        default: false
        }
    }

    /// Ported from `normalizeError`. `RelayVoiceInputError` reaches the native
    /// client as a decoded body rather than a tagged Effect error, so the relay
    /// client hands the code in directly and everything else degrades to a
    /// generic transcription failure carrying the underlying message.
    public static func normalize(_ error: any Error) -> VoiceInputError {
        if let voiceError = error as? VoiceInputError { return voiceError }
        if error is CancellationError {
            return VoiceInputError(code: .requestAborted)
        }
        return VoiceInputError(
            code: .transcriptionFailed,
            message: (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        )
    }

    /// Ported from `voiceInputErrorMessage`.
    public var displayMessage: String {
        switch code {
        case .permissionDenied:
            "Microphone access was denied."
        case .recordingFailed:
            message ?? "Recording failed. Check your microphone and try again."
        case .unauthenticated:
            "Sign in to T3 Connect to use Voice Input."
        case .integrationNotConfigured:
            "Connect OpenRouter in Settings to use Voice Input."
        case .credentialInvalid:
            "Your OpenRouter API key was rejected. Update it in Settings."
        case .invalidAudio, .unsupportedFormat:
            message.map { "The recording could not be processed: \($0)" }
                ?? "The recording could not be processed."
        case .audioTooLarge:
            "The recording is too large to transcribe."
        case .durationExceeded:
            "The recording is longer than the transcription limit."
        case .noSpeech:
            "No speech was detected in the recording."
        case .modelUnavailable:
            "The transcription model is temporarily unavailable."
        case .rateLimited:
            "Transcription is rate limited right now. Try again shortly."
        case .providerPaymentRequired:
            "OpenRouter needs credit to transcribe. Check your account balance."
        case .requestAborted:
            "The transcription request was interrupted."
        case .transcriptionFailed:
            message ?? "Transcription failed. Try again."
        }
    }
}

/// The transcription call, refining the settings surface because Voice Input
/// needs both: the preflight reads the OpenRouter status and the cleanup
/// preference before the microphone opens.
///
/// `transcribeVoice` has a throwing default rather than being a hard
/// requirement so an environment without the relay capability keeps compiling
/// and simply reports the feature as unavailable.
@MainActor
public protocol FeatureVoiceTranscribing: FeatureVoiceSettingsManaging {
    func transcribeVoice(
        _ request: VoiceTranscriptionRequest
    ) async throws -> VoiceTranscriptionResponse
}

public extension FeatureVoiceTranscribing {
    func transcribeVoice(
        _: VoiceTranscriptionRequest
    ) async throws -> VoiceTranscriptionResponse {
        throw FeatureCapabilityUnavailable("Voice Input")
    }
}

/// Where the composer finds the transcription capability.
///
/// Voice Input is *account* state on the T3 Connect relay, not environment
/// state, and the composer is constructed by screens that thread neither a
/// client nor an environment into it. `SettingsView` answers the same question
/// with `model.client as? any FeatureVoiceSettingsManaging`; this is that cast,
/// performed once by the app client at startup so the composer does not have to
/// grow a client dependency it has no other use for.
@MainActor
public enum FeatureVoiceCapability {
    private static weak var registered: (any FeatureVoiceTranscribing)?

    public static var current: (any FeatureVoiceTranscribing)? { registered }

    public static func register(_ capability: (any FeatureVoiceTranscribing)?) {
        registered = capability
    }
}
