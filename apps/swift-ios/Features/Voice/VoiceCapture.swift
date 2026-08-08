import AVFoundation
import Foundation

public enum VoiceCapturePermission: Sendable, Equatable {
    case granted
    /// Refused this time; asking again is still allowed.
    case denied
    /// Refused permanently. Only system settings can undo it.
    case blocked
}

public struct VoiceRecording: Sendable, Equatable {
    /// A complete file in `format`, ready to base64 onto the wire.
    public let data: Data
    public let format: VoiceAudioFormat
    public let durationSeconds: Double?

    public init(data: Data, format: VoiceAudioFormat, durationSeconds: Double? = nil) {
        self.data = data
        self.format = format
        self.durationSeconds = durationSeconds
    }
}

/// Ported from `VoiceCaptureAdapter`. Injectable so the controller's state
/// machine is testable without a microphone.
@MainActor
public protocol VoiceCapturing: AnyObject {
    func requestPermission() async -> VoiceCapturePermission
    /// `onLevel` reports a 0...1 speech envelope for the meter; `onInterrupted`
    /// fires when the session is taken away (a call, another app) so the
    /// controller can stop and keep what was captured.
    func start(
        onLevel: @escaping @MainActor (Double) -> Void,
        onInterrupted: @escaping @MainActor () -> Void
    ) async throws
    func stop() async throws -> VoiceRecording
    func cancel() async
}

public enum VoiceCaptureError: LocalizedError, Equatable {
    case unavailable
    case permissionNotGranted
    case noAudioCaptured
    case recordingTooShort
    /// Bytes were captured, but they carry no signal. Uploading them buys a
    /// blank transcript and, once the cleanup pass is handed that blank, a
    /// conversational reply that reads like a transcript.
    case silentInput

    public var errorDescription: String? {
        switch self {
        case .unavailable:
            "The microphone is unavailable right now."
        case .permissionNotGranted:
            "Microphone access has not been granted."
        case .noAudioCaptured:
            "The recording did not contain usable audio."
        case .recordingTooShort:
            "That was too short to transcribe. Hold the microphone a moment longer."
        case .silentInput:
            "No sound reached the microphone. Check that nothing is covering it "
                + "and that no other app is using it."
        }
    }
}

/// 16 kHz mono 16-bit PCM WAV capture.
///
/// `AVAudioRecorder` can be configured for LinearPCM, but it writes the
/// hardware's own sample rate whenever the requested one is not natively
/// supported, which silently reintroduces the 44.1/48 kHz files the format
/// decision exists to avoid. `AVAudioEngine` plus an explicit `AVAudioConverter`
/// output format guarantees the bytes leaving here are exactly the ones
/// declared in the WAV header.
@MainActor
public final class VoiceMicrophoneCapture: VoiceCapturing {
    /// Matches `LEVEL_SAMPLE_INTERVAL_MS`.
    private static let levelSampleInterval = Duration.milliseconds(100)

    /// Rebuilt per recording rather than held for the lifetime of the app.
    ///
    /// `AVAudioEngine` resolves its input node against the session that was
    /// active when the node was first touched and caches that node's format.
    /// Since teardown deactivates the session, a reused engine can carry a
    /// format from a route that no longer exists, and a tap installed against
    /// the stale format is the one shape of this bug that never reports itself.
    private var engine = AVAudioEngine()
    private let sink = VoicePCMSink()
    private var isCapturing = false
    private var levelTask: Task<Void, Never>?
    private var interruptionObserver: (any NSObjectProtocol)?
    private var didInterrupt = false
    /// Held past `start` so teardown can flush whatever the resampler is still
    /// buffering instead of dropping it.
    private var converter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?

    public init() {}

    deinit {
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
        }
    }

    public func requestPermission() async -> VoiceCapturePermission {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return .granted
        case .denied:
            // iOS never re-prompts after a denial, so this is `blocked` in the
            // shared adapter's vocabulary: the retry has to be a Settings trip.
            return .blocked
        default:
            break
        }
        let granted = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        return granted ? .granted : .denied
    }

    public func start(
        onLevel: @escaping @MainActor (Double) -> Void,
        onInterrupted: @escaping @MainActor () -> Void
    ) async throws {
        await cancel()
        didInterrupt = false
        VoiceCaptureDiagnostics.beginRun("voice capture start")

        // Checked here and not only in the controller: iOS does not fail an
        // engine start without record permission, it hands back a running tap
        // full of zeros. Without this guard a revoked or never-granted mic
        // produces a perfectly well-formed silent WAV.
        let permission = AVAudioApplication.shared.recordPermission
        VoiceCaptureDiagnostics.record(
            "permission=\(VoiceCaptureDiagnostics.describe(permission: permission))"
        )
        guard permission == .granted else { throw VoiceCaptureError.permissionNotGranted }

        let session = AVAudioSession.sharedInstance()
        // `.record`, not `.playAndRecord`: nothing here plays while the
        // microphone is open, and `.playAndRecord` drags in an output route —
        // and with it `.defaultToSpeaker`, which exists only to move that output
        // — for no benefit. A record-only session also takes the input outright
        // instead of sharing it with whatever else is making noise.
        //
        // `.default`, not `.measurement`: `.measurement` is the mode that
        // *disables* the input chain (AGC, EQ, noise suppression). That is right
        // for an app measuring a signal and wrong for one handing handheld
        // speech to a remote transcriber — without gain control a phone held at
        // arm's length lands tens of decibels below what a speech model needs,
        // and a model given near-silence returns an empty transcript rather than
        // an error.
        try session.setCategory(.record, mode: .default, options: [])
        try session.setActive(true, options: [])
        VoiceCaptureDiagnostics.record(VoiceCaptureDiagnostics.describe(session: session))
        guard session.isInputAvailable else {
            VoiceCaptureDiagnostics.record("abort: session reports no input available")
            throw VoiceCaptureError.unavailable
        }

        engine = AVAudioEngine()
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        VoiceCaptureDiagnostics.record(
            VoiceCaptureDiagnostics.describe(format: inputFormat, label: "input")
        )
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            VoiceCaptureDiagnostics.record("abort: input node reported an empty format")
            throw VoiceCaptureError.unavailable
        }
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: Double(VoiceWaveFile.sampleRate),
            channels: AVAudioChannelCount(VoiceWaveFile.channelCount),
            interleaved: true
        ), let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            VoiceCaptureDiagnostics.record("abort: could not build the 16 kHz converter")
            throw VoiceCaptureError.unavailable
        }
        VoiceCaptureDiagnostics.record(
            VoiceCaptureDiagnostics.describe(format: targetFormat, label: "target")
        )
        self.converter = converter
        self.targetFormat = targetFormat

        sink.reset(
            maximumByteCount: Int(
                VoiceInputLimits.maximumDurationSeconds * Double(VoiceWaveFile.byteRate())
            )
        )
        let sink = sink
        input.installTap(onBus: 0, bufferSize: 4_096, format: inputFormat) { buffer, _ in
            sink.append(buffer, using: converter, to: targetFormat)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            VoiceCaptureDiagnostics.record("abort: engine.start threw \(error)")
            throw error
        }
        isCapturing = true
        VoiceCaptureDiagnostics.record("engine running")

        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: session,
            queue: .main
        ) { [weak self] notification in
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
            MainActor.assumeIsolated {
                guard let self, !self.didInterrupt else { return }
                self.didInterrupt = true
                VoiceCaptureDiagnostics.record("interrupted")
                onInterrupted()
            }
        }

        // Polled rather than pushed from the audio thread: the tap fires far
        // faster than a meter can be read, and the shared adapter samples on the
        // same 100 ms cadence.
        levelTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.levelSampleInterval)
                guard !Task.isCancelled, let self, self.isCapturing else { return }
                onLevel(self.sink.takeLevel())
            }
        }
    }

    public func stop() async throws -> VoiceRecording {
        guard isCapturing else { throw VoiceCaptureError.noAudioCaptured }
        let (samples, tally) = teardown()

        // Measured before the header goes on, so what is checked is the payload
        // rather than the 44 bytes that are always there.
        let audit = VoiceCaptureAudit.audit(samples: samples)
        VoiceCaptureDiagnostics.record(tally.description)
        VoiceCaptureDiagnostics.record("audit \(audit)")
        if let rejection = audit.rejection {
            VoiceCaptureDiagnostics.record("rejected: \(rejection.errorDescription ?? "")")
            throw rejection
        }
        if audit.isQuiet {
            VoiceCaptureDiagnostics.record(
                "warning: the whole recording sits below "
                    + "\(VoiceCaptureAudit.quietPeakDecibels) dBFS peak"
            )
        }

        return VoiceRecording(
            data: VoiceWaveFile.file(samples: samples),
            format: .wav,
            durationSeconds: audit.durationSeconds
        )
    }

    public func cancel() async {
        guard isCapturing else { return }
        let (samples, tally) = teardown()
        // Logged even though the audio is being thrown away: a run the user
        // discarded is still a run whose capture numbers say whether the
        // microphone was working.
        VoiceCaptureDiagnostics.record("discarded \(tally)")
        VoiceCaptureDiagnostics.record(
            "discarded audit \(VoiceCaptureAudit.audit(samples: samples))"
        )
    }

    private func teardown() -> (samples: Data, tally: VoiceConversionTally) {
        levelTask?.cancel()
        levelTask = nil
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
            self.interruptionObserver = nil
        }
        if isCapturing {
            engine.inputNode.removeTap(onBus: 0)
            // Blocks until the render thread has stopped, so the converter is
            // ours again and flushing it cannot race a tap still in flight.
            engine.stop()
            if let converter, let targetFormat {
                sink.finish(using: converter, to: targetFormat)
            }
        }
        isCapturing = false
        converter = nil
        targetFormat = nil
        let drained = sink.drain()
        // Best effort: another app may already own the session, and failing to
        // hand it back is not a reason to lose the recording.
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        return drained
    }
}

/// Accumulates converted PCM off the render thread.
///
/// The tap callback runs on a real-time audio thread that must never block on
/// the main actor, so the buffer and the meter level live behind a plain lock
/// and are read from the main actor on the sampling cadence.
private final class VoicePCMSink: @unchecked Sendable {
    /// Metering is reported in dBFS; -50 dB reads as silence for the meter.
    private static let levelFloorDecibels = -50.0

    private let lock = NSLock()
    private var samples = Data()
    private var level = 0.0
    private var maximumByteCount = Int.max
    private var tally = VoiceConversionTally()

    func reset(maximumByteCount: Int) {
        lock.lock()
        defer { lock.unlock() }
        samples = Data()
        level = 0
        tally = VoiceConversionTally()
        self.maximumByteCount = max(0, maximumByteCount)
    }

    func drain() -> (samples: Data, tally: VoiceConversionTally) {
        lock.lock()
        defer { lock.unlock() }
        let drained = samples
        let drainedTally = tally
        samples = Data()
        level = 0
        tally = VoiceConversionTally()
        return (drained, drainedTally)
    }

    func takeLevel() -> Double {
        lock.lock()
        defer { lock.unlock() }
        return level
    }

    func append(
        _ buffer: AVAudioPCMBuffer,
        using converter: AVAudioConverter,
        to format: AVAudioFormat
    ) {
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1_024
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
            return
        }
        var consumed = false
        var conversionError: NSError?
        // One tap buffer per conversion pass: reporting `.haveData` twice would
        // replay the same audio. The pass therefore ends on `.inputRanDry`,
        // which is the expected status here and not a failure — the resampler
        // emits every whole output frame it can build from the input it was
        // given and keeps only the handful of samples straddling the boundary.
        let status = converter.convert(to: converted, error: &conversionError) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }

        lock.lock()
        tally.tapCallbacks += 1
        tally.inputFrames += Int(buffer.frameLength)
        tally.record(status: status)
        if let conversionError {
            if tally.firstErrorCode == 0 { tally.firstErrorCode = conversionError.code }
        }
        if conversionError == nil, converted.frameLength == 0 { tally.emptyPasses += 1 }
        lock.unlock()

        guard conversionError == nil, converted.frameLength > 0 else { return }
        store(converted)
    }

    /// Flushes the frames the resampler is still holding once the tap has been
    /// removed. Small — a handful of samples — but it is the only part of the
    /// pipeline that would otherwise be dropped on the floor by design.
    func finish(using converter: AVAudioConverter, to format: AVAudioFormat) {
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4_096) else {
            return
        }
        var conversionError: NSError?
        _ = converter.convert(to: converted, error: &conversionError) { _, status in
            status.pointee = .endOfStream
            return nil
        }
        guard conversionError == nil, converted.frameLength > 0 else { return }
        lock.lock()
        tally.tailFrames += Int(converted.frameLength)
        lock.unlock()
        store(converted)
    }

    private func store(_ converted: AVAudioPCMBuffer) {
        guard let channel = converted.int16ChannelData?[0] else { return }
        let frameCount = Int(converted.frameLength)

        var sumOfSquares = 0.0
        for index in 0..<frameCount {
            let sample = Double(channel[index]) / 32_768
            sumOfSquares += sample * sample
        }
        let rootMeanSquare = (sumOfSquares / Double(frameCount)).squareRoot()
        // Matches the shared adapter: dBFS mapped onto 0...1 with a -50 dB floor.
        let decibels = rootMeanSquare > 0 ? 20 * log10(rootMeanSquare) : Self.levelFloorDecibels
        let normalized = min(
            1,
            max(0, (decibels - Self.levelFloorDecibels) / -Self.levelFloorDecibels)
        )

        lock.lock()
        defer { lock.unlock() }
        level = normalized
        tally.outputFrames += frameCount
        guard samples.count < maximumByteCount else {
            tally.cappedPasses += 1
            return
        }
        channel.withMemoryRebound(to: UInt8.self, capacity: frameCount * 2) { bytes in
            samples.append(bytes, count: frameCount * 2)
        }
    }
}
