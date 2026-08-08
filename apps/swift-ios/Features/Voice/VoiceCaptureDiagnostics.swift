import AVFoundation
import Foundation

/// A Debug-build record of what the microphone actually did, written where a
/// tethered Mac can read it back off the device.
///
/// The capture path has no failure mode that surfaces anywhere: a session that
/// routes nothing, a permission that was never granted, and a converter that
/// emits nothing all produce the same thing — a recording that uploads cleanly
/// and comes back as an empty transcript. Rather than infer which one happened,
/// every run writes its own session state, per-pass converter accounting and a
/// measurement of the assembled PCM to a file in the app container.
///
/// Pull it with:
/// ```
/// xcrun devicectl device copy from --device <udid> \
///   --domain-type appDataContainer --domain-identifier <bundle id> \
///   --source Documents/voice-capture-diagnostics.log \
///   --destination ./voice-capture-diagnostics.log
/// ```
///
/// Release builds compile every call site down to nothing: the message is an
/// `@autoclosure` that is never evaluated.
public enum VoiceCaptureDiagnostics {
    public static let fileName = "voice-capture-diagnostics.log"
    /// Rolled rather than grown without bound: this is a debugging aid living in
    /// a user-visible container, not a log the app depends on.
    private static let maximumByteCount = 512 * 1_024

    private static let lock = NSLock()

    public static var fileURL: URL? {
        FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent(fileName, isDirectory: false)
    }

    public static func record(_ message: @autoclosure () -> String) {
        #if DEBUG
            append(message())
        #endif
    }

    /// Clears the log at the start of a run so the file only ever holds the
    /// recording the tester is about to make.
    public static func beginRun(_ label: String) {
        #if DEBUG
            lock.lock()
            if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
            lock.unlock()
            append("=== \(label) ===")
        #endif
    }

    #if DEBUG
        private static let timestamps: ISO8601DateFormatter = {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return formatter
        }()

        private static func append(_ message: String) {
            lock.lock()
            defer { lock.unlock() }
            guard let fileURL else { return }
            guard let line = "\(timestamps.string(from: Date())) \(message)\n"
                .data(using: .utf8) else { return }

            let manager = FileManager.default
            if let size = try? manager.attributesOfItem(atPath: fileURL.path)[.size] as? Int,
               size > maximumByteCount {
                try? manager.removeItem(at: fileURL)
            }
            guard let handle = try? FileHandle(forWritingTo: fileURL) else {
                try? line.write(to: fileURL, options: .atomic)
                return
            }
            defer { try? handle.close() }
            guard (try? handle.seekToEnd()) != nil else { return }
            try? handle.write(contentsOf: line)
        }
    #endif
}

// MARK: - Snapshots

public extension VoiceCaptureDiagnostics {
    /// Everything about the session that decides whether the tap will carry
    /// audio: the category and mode actually in force (not the ones requested),
    /// the negotiated sample rate, whether an input exists at all, and which
    /// port the route landed on.
    static func describe(session: AVAudioSession) -> String {
        let route = session.currentRoute
        let inputs = route.inputs
            .map { "\($0.portType.rawValue)/\($0.portName)" }
            .joined(separator: ",")
        let outputs = route.outputs
            .map { "\($0.portType.rawValue)/\($0.portName)" }
            .joined(separator: ",")
        return """
        session category=\(session.category.rawValue) mode=\(session.mode.rawValue) \
        options=\(session.categoryOptions.rawValue) \
        sampleRate=\(session.sampleRate) preferredSampleRate=\(session.preferredSampleRate) \
        ioBuffer=\(session.ioBufferDuration) \
        inputAvailable=\(session.isInputAvailable) \
        inputChannels=\(session.inputNumberOfChannels) \
        inputGain=\(session.inputGain) gainSettable=\(session.isInputGainSettable) \
        otherAudioPlaying=\(session.isOtherAudioPlaying) \
        inputs=[\(inputs.isEmpty ? "none" : inputs)] \
        outputs=[\(outputs.isEmpty ? "none" : outputs)]
        """
    }

    static func describe(format: AVAudioFormat, label: String) -> String {
        """
        \(label) sampleRate=\(format.sampleRate) channels=\(format.channelCount) \
        common=\(format.commonFormat.rawValue) interleaved=\(format.isInterleaved)
        """
    }

    static func describe(permission: AVAudioApplication.recordPermission) -> String {
        switch permission {
        case .granted: "granted"
        case .denied: "denied"
        case .undetermined: "undetermined"
        @unknown default: "unknown(\(permission.rawValue))"
        }
    }
}

// MARK: - Converter accounting

/// Per-pass accounting for the tap, gathered on the audio thread and reported
/// once at teardown.
///
/// Counters only — no allocation, no formatting and no file I/O on the render
/// thread. The one string it can hold is the converter's first error, which by
/// definition happens at most once per recording.
public struct VoiceConversionTally: Sendable, Equatable {
    public var tapCallbacks = 0
    public var inputFrames = 0
    public var outputFrames = 0
    /// Passes the converter accepted input for but returned no frames from.
    /// The guard in the sink drops these; if the count is ever non-zero the
    /// resampler is buffering across passes and audio is being lost.
    public var emptyPasses = 0
    public var haveDataPasses = 0
    public var inputRanDryPasses = 0
    public var endOfStreamPasses = 0
    public var errorPasses = 0
    /// Passes dropped because the duration cap had already been reached.
    public var cappedPasses = 0
    public var firstErrorCode = 0
    public var tailFrames = 0

    public init() {}

    public mutating func record(status: AVAudioConverterOutputStatus) {
        switch status {
        case .haveData: haveDataPasses += 1
        case .inputRanDry: inputRanDryPasses += 1
        case .endOfStream: endOfStreamPasses += 1
        case .error: errorPasses += 1
        @unknown default: break
        }
    }
}

extension VoiceConversionTally: CustomStringConvertible {
    public var description: String {
        """
        converter taps=\(tapCallbacks) inFrames=\(inputFrames) outFrames=\(outputFrames) \
        empty=\(emptyPasses) capped=\(cappedPasses) tail=\(tailFrames) \
        status[haveData=\(haveDataPasses) inputRanDry=\(inputRanDryPasses) \
        endOfStream=\(endOfStreamPasses) error=\(errorPasses)] \
        firstErrorCode=\(firstErrorCode)
        """
    }
}
