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
    case noAudioCaptured

    public var errorDescription: String? {
        switch self {
        case .unavailable:
            "The microphone is unavailable right now."
        case .noAudioCaptured:
            "The recording did not contain usable audio."
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

    private let engine = AVAudioEngine()
    private let sink = VoicePCMSink()
    private var isCapturing = false
    private var levelTask: Task<Void, Never>?
    private var interruptionObserver: (any NSObjectProtocol)?
    private var didInterrupt = false

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

        let session = AVAudioSession.sharedInstance()
        // `.measurement` disables the input processing chain (AGC, EQ) that
        // colours speech before it reaches the transcriber.
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker])
        try session.setActive(true, options: [])

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw VoiceCaptureError.unavailable
        }
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: Double(VoiceWaveFile.sampleRate),
            channels: AVAudioChannelCount(VoiceWaveFile.channelCount),
            interleaved: true
        ), let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw VoiceCaptureError.unavailable
        }

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
            throw error
        }
        isCapturing = true

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
        let samples = teardown()
        guard !samples.isEmpty else { throw VoiceCaptureError.noAudioCaptured }
        return VoiceRecording(
            data: VoiceWaveFile.file(samples: samples),
            format: .wav,
            durationSeconds: VoiceWaveFile.durationSeconds(dataByteCount: samples.count)
        )
    }

    public func cancel() async {
        guard isCapturing else { return }
        _ = teardown()
    }

    @discardableResult
    private func teardown() -> Data {
        levelTask?.cancel()
        levelTask = nil
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
            self.interruptionObserver = nil
        }
        if isCapturing {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        isCapturing = false
        let samples = sink.drain()
        // Best effort: another app may already own the session, and failing to
        // hand it back is not a reason to lose the recording.
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        return samples
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

    func reset(maximumByteCount: Int) {
        lock.lock()
        defer { lock.unlock() }
        samples = Data()
        level = 0
        self.maximumByteCount = max(0, maximumByteCount)
    }

    func drain() -> Data {
        lock.lock()
        defer { lock.unlock() }
        let drained = samples
        samples = Data()
        level = 0
        return drained
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
        converter.convert(to: converted, error: &conversionError) { _, status in
            // One tap buffer per conversion pass: reporting `.haveData` twice
            // would replay the same audio.
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard conversionError == nil,
              converted.frameLength > 0,
              let channel = converted.int16ChannelData?[0] else {
            return
        }
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
        guard samples.count < maximumByteCount else { return }
        channel.withMemoryRebound(to: UInt8.self, capacity: frameCount * 2) { bytes in
            samples.append(bytes, count: frameCount * 2)
        }
    }
}
