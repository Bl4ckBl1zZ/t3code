import SwiftUI

// The composer's voice surface: a bare mic glyph beside the send button while
// idle, and a recording strip that takes over the whole pill while capturing —
// cancel on the left, live waveform in the middle, and the mic button turned
// into the voice send circle on the right. A floating "Release to send /
// Release to cancel" hint narrates a push-to-talk hold; sliding up arms the
// cancel and turns the strip red.

enum VoiceMorph {
    /// Physical rather than timed: the surface is a thing being pushed, so it
    /// settles with a little overshoot instead of decelerating to a stop.
    static let surface = Animation.spring(response: 0.42, dampingFraction: 0.78)
    static let control = Animation.spring(response: 0.32, dampingFraction: 0.66)
    static let armed = Animation.spring(response: 0.26, dampingFraction: 0.55)

    /// Reduce Motion keeps every state change legible, but as a cross-fade: no
    /// travel, no overshoot, no repeating pulse.
    static let reduced = Animation.easeInOut(duration: 0.18)

    /// The animation the composer wraps the strip's appearance in. Both halves
    /// of the swap have to change inside one transaction, so the owner of both
    /// drives it.
    static func appearance(reduceMotion: Bool) -> Animation {
        reduceMotion ? reduced : surface
    }
}

/// The microphone control.
///
/// Push-to-talk, not slide-to-cancel: a tap starts hands-free recording, a hold
/// records for as long as the finger stays down, and release confirms. Sliding
/// up only *arms* the discard — the release is what decides. While anything is
/// being recorded the same control becomes the voice send circle, so the finger
/// that started a hold is already resting on the button that finishes it.
struct VoiceMicButton: View {
    @Bindable var voice: VoiceComposerCoordinator

    @SwiftUI.Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isPressed = false

    /// `canSend: false` on purpose: the mic never sends the text draft. A tap
    /// while idle starts recording, a tap while recording stops and
    /// transcribes.
    private var action: VoiceComboButtonAction {
        VoiceComboButtonAction(canSend: false, send: {})
    }

    private var isTranscribing: Bool {
        switch voice.state {
        case .stopping, .transcribing: return true
        default: return false
        }
    }

    var body: some View {
        surface
            .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
            .gesture(pushToTalkGesture)
            .accessibilityElement()
            .accessibilityLabel(accessibilityLabel)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier(voice.state.isRecording ? "voice-stop" : "voice-record")
            .accessibilityAction {
                guard !isTranscribing else { return }
                voice.activate(button: action)
            }
    }

    /// One stable tree for every state — the circle, the spinner and the glyph
    /// are always present and only animate their properties. A `ViewBuilder`
    /// branch swap here would replace the view mid-touch and take the in-flight
    /// push-to-talk gesture down with it: the release would never arrive, the
    /// recording would run on, and slide-to-cancel would never arm. That is
    /// also why `.disabled` is not used — flipping it resets gestures too, so
    /// the handlers guard instead.
    private var surface: some View {
        ZStack {
            Circle()
                .fill(T3Colors.primaryAction)
                .opacity(voice.state.isBusy ? (isTranscribing ? 0.5 : 1) : 0)
            ProgressView()
                .controlSize(.small)
                .tint(T3Colors.primaryActionForeground)
                .opacity(isTranscribing ? 1 : 0)
            Image(systemName: voice.state.isBusy ? "arrow.up" : "mic")
                .font(
                    voice.state.isBusy
                        ? .system(size: 15, weight: .bold)
                        : .system(size: 19, weight: .medium)
                )
                .foregroundStyle(
                    voice.state.isBusy ? T3Colors.primaryActionForeground : T3Colors.textPrimary
                )
                .contentTransition(
                    reduceMotion ? ContentTransition.opacity : .symbolEffect(.replace)
                )
                .opacity(isTranscribing ? 0 : 1)
        }
        .frame(width: 34, height: 34)
        .scaleEffect(scale)
        .animation(reduceMotion ? VoiceMorph.reduced : VoiceMorph.control, value: isPressed)
        .animation(VoiceMorph.appearance(reduceMotion: reduceMotion), value: voice.state.isBusy)
        .animation(reduceMotion ? VoiceMorph.reduced : VoiceMorph.control, value: isTranscribing)
    }

    private var scale: CGFloat {
        if reduceMotion { return 1 }
        return isPressed && !voice.state.isBusy ? 0.9 : 1
    }

    private var accessibilityLabel: String {
        if isTranscribing { return "Transcribing voice input" }
        if voice.state.isRecording { return "Stop recording and transcribe" }
        return "Dictate message. Hold to record"
    }

    /// A zero-distance drag is the only recognizer that reports touch-down,
    /// absolute movement and release. Claiming the touch on touch-down also
    /// keeps enclosing recognizers (sheet drag, scroll) from stealing the hold
    /// mid-recording.
    private var pushToTalkGesture: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .global)
            .onChanged { value in
                guard !isTranscribing else { return }
                // `ownsActiveTouch` recovers from a gesture the system tore
                // down without an `onEnded`: the stale `isPressed` would
                // otherwise swallow the press of every later touch.
                if !isPressed || !voice.ownsActiveTouch() {
                    isPressed = true
                    voice.press(y: value.startLocation.y, button: action)
                }
                voice.move(y: value.location.y, button: action)
            }
            .onEnded { _ in
                guard isPressed else { return }
                isPressed = false
                voice.release(button: action)
            }
    }
}

/// The floating hint above the composer while a push-to-talk hold is down. Both
/// labels name what releasing right now does, because release is the only thing
/// that decides: wandering into the cancel zone arms the discard, it does not
/// perform it.
struct VoiceReleaseHint: View {
    let armed: Bool

    var body: some View {
        Text(armed ? "Release to cancel" : "Release to send")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(armed ? T3Colors.danger : T3Colors.textSecondary)
            // A chip, not bare text: the hint floats over the transcript now
            // that the composer has no backdrop, so it brings its own.
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .t3GlassEffect(.regular, in: Capsule())
            .overlay { Capsule().stroke(T3Colors.border, lineWidth: 1) }
            .animation(VoiceMorph.armed, value: armed)
            .accessibilityIdentifier("voice-hold-hint")
    }
}

/// The recording take-over of the composer pill: cancel circle, elapsed clock,
/// then the waveform filling whatever width is left. Renders nothing when Voice
/// Input is idle.
struct VoiceRecordingStrip: View {
    @Bindable var voice: VoiceComposerCoordinator

    @SwiftUI.Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 8) {
            switch voice.state {
            case let .recording(startedAt, _):
                cancelButton(armed: voice.cancelArmed)
                VoiceRecordingClock(startedAt: startedAt)
                    .modifier(VoiceArmedDimming(armed: voice.cancelArmed, reduced: reduceMotion))
                VoiceWaveformView(voice: voice, reduceMotion: reduceMotion)
            case .requestingPermission:
                // No cancel affordance: the OS permission sheet owns the screen,
                // and this exists only so a first-time user sees the flow
                // started.
                ProgressView()
                    .controlSize(.small)
                    .padding(.leading, 10)
                Text("Waiting for microphone access…")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                Spacer(minLength: 0)
            case .stopping, .transcribing:
                cancelButton(armed: false)
                VoiceTranscribingDots()
                Text("Transcribing…")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                Spacer(minLength: 0)
            case .idle, .completed, .failed:
                EmptyView()
            }
        }
        .padding(.leading, 5)
        .padding(.trailing, 4)
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .accessibilityIdentifier("voice-recording-bar")
    }

    /// Arming slide-to-cancel flips the neutral circle to the danger fill —
    /// the same red the released cancel would be, so "let go and this is gone"
    /// is already painted on the control.
    private func cancelButton(armed: Bool) -> some View {
        Button {
            voice.cancelRecording()
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(armed ? Color.white : T3Colors.textPrimary)
                .frame(width: 30, height: 30)
                .background(armed ? T3Colors.danger : T3Colors.subtleStrong, in: Circle())
                .scaleEffect(armed && !reduceMotion ? 1.12 : 1)
                .frame(width: 36, height: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(reduceMotion ? VoiceMorph.reduced : VoiceMorph.armed, value: armed)
        .accessibilityLabel("Cancel recording")
    }
}

/// Dims what slide-to-cancel is about to throw away.
private struct VoiceArmedDimming: ViewModifier {
    let armed: Bool
    let reduced: Bool

    func body(content: Content) -> some View {
        content
            .opacity(armed ? 0.35 : 1)
            .animation(reduced ? VoiceMorph.reduced : VoiceMorph.armed, value: armed)
    }
}

/// The rolling record of level samples behind the waveform. Silence still
/// scrolls: a slot with no signal renders as a baseline dot, so the strip reads
/// as tape moving past the head rather than a meter that froze.
struct VoiceWaveformHistory: Equatable {
    /// Comfortably more than any width can show; the window is what renders.
    static let capacity = 400

    private(set) var samples: [Double] = []

    mutating func append(_ level: Double) {
        samples.append(min(1, max(0, level)))
        if samples.count > Self.capacity {
            samples.removeFirst(samples.count - Self.capacity)
        }
    }

    /// The right-aligned window the view draws: the newest sample is always the
    /// last bar, and slots that have no sample yet are zero — the baseline dot.
    func bars(slots: Int) -> [Double] {
        guard slots > 0 else { return [] }
        let window = Array(samples.suffix(slots))
        return Array(repeating: 0, count: slots - window.count) + window
    }
}

/// The waveform's fixed metrics, kept out of the view so the layout math is
/// testable without rendering.
enum VoiceWaveformGeometry {
    static let barWidth: CGFloat = 2.5
    static let barSpacing: CGFloat = 2.5
    static let maximumHeight: CGFloat = 22
    /// The baseline dot: what silence and the not-yet-recorded remainder of the
    /// strip look like.
    static let minimumHeight: CGFloat = 2.5

    static func slots(fitting width: CGFloat) -> Int {
        guard width.isFinite, width > 0 else { return 0 }
        return max(0, Int((width + barSpacing) / (barWidth + barSpacing)))
    }

    static func height(for sample: Double) -> CGFloat {
        let clamped = min(1, max(0, sample))
        // The sub-linear exponent lifts quiet speech into a visible ripple
        // instead of leaving everything below a shout on the baseline.
        return minimumHeight + CGFloat(pow(clamped, 0.7)) * (maximumHeight - minimumHeight)
    }
}

/// The scrolling waveform. Sampled on a fixed clock rather than on level
/// changes, because the tape has to keep moving through silence.
private struct VoiceWaveformView: View {
    @Bindable var voice: VoiceComposerCoordinator
    let reduceMotion: Bool

    @State private var history = VoiceWaveformHistory()

    var body: some View {
        GeometryReader { proxy in
            let bars = history.bars(slots: VoiceWaveformGeometry.slots(fitting: proxy.size.width))
            HStack(spacing: VoiceWaveformGeometry.barSpacing) {
                ForEach(bars.indices, id: \.self) { index in
                    Capsule()
                        .fill(T3Colors.textPrimary)
                        .frame(
                            width: VoiceWaveformGeometry.barWidth,
                            height: VoiceWaveformGeometry.height(for: bars[index])
                        )
                        .opacity(bars[index] > 0.03 ? 1 : 0.35)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .frame(height: VoiceWaveformGeometry.maximumHeight)
        .frame(maxWidth: .infinity)
        .modifier(VoiceArmedDimming(armed: voice.cancelArmed, reduced: reduceMotion))
        .accessibilityHidden(true)
        .task {
            // 10 samples a second matches the recorder's own publish rate; the
            // coordinator is read fresh each tick so the loop never holds a
            // stale level.
            while !Task.isCancelled {
                history.append(voice.state.isRecording ? voice.level : 0)
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }
}

private struct VoiceRecordingClock: View {
    let startedAt: Date

    private static let countdownThreshold = 15

    var body: some View {
        TimelineView(.periodic(from: startedAt, by: 0.25)) { context in
            let elapsed = max(0, Int(context.date.timeIntervalSince(startedAt)))
            let remaining = max(0, Int(VoiceInputLimits.maximumDurationSeconds) - elapsed)
            let showsCountdown = remaining <= Self.countdownThreshold
            Text(showsCountdown ? "-\(clock(remaining))" : clock(elapsed))
                .font(T3Typography.supporting.monospacedDigit())
                .foregroundStyle(showsCountdown ? T3Colors.danger : T3Colors.textSecondary)
                // A wrapped or truncated clock is unreadable, and it is the one
                // element in the row narrow enough that it never has to be.
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .accessibilityLabel(
                    showsCountdown
                        ? "Recording, \(remaining) seconds remaining"
                        : "Recording, \(clock(elapsed))"
                )
        }
    }

    private func clock(_ seconds: Int) -> String {
        String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

private struct VoiceTranscribingDots: View {
    @SwiftUI.Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var active = false

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(T3Colors.textSecondary)
                    .frame(width: 6, height: 6)
                    .opacity(active ? 1 : 0.3)
                    .animation(
                        reduceMotion
                            ? nil
                            : .easeInOut(duration: 0.37)
                                .repeatForever(autoreverses: true)
                                .delay(Double(index) * 0.14),
                        value: active
                    )
            }
        }
        .frame(height: 16)
        .accessibilityHidden(true)
        .onAppear { active = true }
    }
}
