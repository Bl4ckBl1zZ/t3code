import SwiftUI

// Ported from apps/mobile/src/features/voice/VoiceComposerControls.tsx.

/// The combined send/record button's appearance. Ported from
/// `voiceComboButtonProps`.
struct VoiceComboButtonAppearance: Equatable {
    let systemImage: String
    let isDanger: Bool
    let isDisabled: Bool
    let accessibilityLabel: String

    static func resolve(state: VoiceInputState, canSend: Bool) -> VoiceComboButtonAppearance {
        if state.isRecording {
            return VoiceComboButtonAppearance(
                systemImage: "stop.fill",
                isDanger: true,
                isDisabled: false,
                accessibilityLabel: "Stop recording and transcribe"
            )
        }
        let busy = state.isBusy
        if canSend, !busy {
            return VoiceComboButtonAppearance(
                systemImage: "arrow.up",
                isDanger: false,
                isDisabled: false,
                accessibilityLabel: "Send. Hold to dictate"
            )
        }
        if case .transcribing = state {
            return VoiceComboButtonAppearance(
                systemImage: "mic.fill",
                isDanger: false,
                isDisabled: true,
                accessibilityLabel: "Transcribing voice input"
            )
        }
        return VoiceComboButtonAppearance(
            systemImage: "mic.fill",
            isDanger: false,
            isDisabled: busy,
            accessibilityLabel: "Dictate message. Hold to record"
        )
    }
}

/// The combined send/record control.
///
/// Push-to-talk, not slide-to-cancel: a tap sends (or starts hands-free
/// recording when the draft is empty), a hold records for as long as the finger
/// stays down, and release confirms. Sliding up past the cancel target only
/// *arms* the discard — the release is what decides.
struct VoiceComboButton: View {
    @Bindable var voice: VoiceComposerCoordinator
    let canSend: Bool
    let isSending: Bool
    let onSend: () -> Void

    @SwiftUI.Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isPressed = false

    private var appearance: VoiceComboButtonAppearance {
        VoiceComboButtonAppearance.resolve(state: voice.state, canSend: canSend)
    }

    private var action: VoiceComboButtonAction {
        VoiceComboButtonAction(canSend: canSend, send: onSend)
    }

    var body: some View {
        surface
            .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
            .gesture(pushToTalkGesture)
            .accessibilityElement()
            .accessibilityLabel(appearance.accessibilityLabel)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier(voice.state.isRecording ? "voice-stop" : "message-send")
            .accessibilityAction { voice.activate(button: action) }
    }

    private var surface: some View {
        Group {
            if isSending {
                ProgressView()
                    .controlSize(.small)
                    .tint(.white)
            } else {
                Image(systemName: appearance.systemImage)
                    .font(.system(size: appearance.systemImage == "arrow.up" ? 14 : 15, weight: .bold))
                    .contentTransition(.symbolEffect(.replace))
            }
        }
        .foregroundStyle(.white)
        .frame(width: 34, height: 34)
        .background(appearance.isDanger ? T3Colors.danger : T3Colors.accent, in: Circle())
        .overlay(alignment: .bottomTrailing) {
            // The visual hint that holding the send button still dictates.
            if appearance.systemImage == "arrow.up" {
                Image(systemName: "mic.fill")
                    .font(.system(size: 7, weight: .bold))
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(width: 14, height: 14)
                    .background(T3Colors.background, in: Circle())
                    .overlay(Circle().stroke(T3Colors.border, lineWidth: 1))
                    .offset(x: 2, y: 2)
                    .allowsHitTesting(false)
            }
        }
        .opacity(appearance.isDisabled ? 0.35 : 1)
        .scaleEffect(isPressed && !reduceMotion ? 0.92 : 1)
        .animation(.easeOut(duration: 0.12), value: isPressed)
    }

    /// A zero-distance drag is the only recognizer that reports touch-down,
    /// absolute movement and release. Claiming the touch on touch-down also
    /// keeps enclosing recognizers (sheet drag, scroll) from stealing the hold
    /// mid-recording.
    private var pushToTalkGesture: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .global)
            .onChanged { value in
                guard !appearance.isDisabled else { return }
                if !isPressed {
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

/// Floating slide-to-cancel target above the combo button, visible only while a
/// push-to-talk hold is in progress. It is a release target, not a tripwire:
/// reaching it arms the discard and sliding back off disarms.
struct VoiceCancelTarget: View {
    let holdActive: Bool
    let cancelArmed: Bool
    let progress: Double

    var body: some View {
        if holdActive {
            Image(systemName: "xmark")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(cancelArmed ? Color.white : T3Colors.textSecondary)
                .frame(width: 32, height: 32)
                .background(cancelArmed ? T3Colors.danger : T3Colors.subtleStrong, in: Circle())
                .overlay {
                    Circle().stroke(
                        cancelArmed ? T3Colors.danger : T3Colors.border,
                        lineWidth: 1
                    )
                }
                .scaleEffect(0.75 + 0.45 * min(max(progress, 0), 1))
                .animation(.spring(response: 0.28, dampingFraction: 0.72), value: progress)
                .animation(.spring(response: 0.24, dampingFraction: 0.6), value: cancelArmed)
                .transition(.scale.combined(with: .opacity))
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }
}

/// Live recording/transcribing status row. One container morphs between the
/// states so the eye tracks a single element; it renders nothing when Voice
/// Input is idle, so it can sit unconditionally above the composer toolbar.
struct VoiceRecordingBar: View {
    @Bindable var voice: VoiceComposerCoordinator

    var body: some View {
        switch voice.state {
        case let .recording(startedAt, cleanup):
            recording(startedAt: startedAt, cleanup: cleanup)
        case .requestingPermission:
            // No cancel affordance: the OS permission sheet owns the screen, and
            // this exists only so a first-time user sees the flow started.
            row {
                ProgressView().controlSize(.small)
                Text("Waiting for microphone access…")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Waiting for microphone access")
        case .stopping, .transcribing:
            row {
                VoiceTranscribingDots()
                Text("Transcribing…")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                Spacer(minLength: 0)
                cancelButton(label: "Cancel transcription")
            }
        case .idle, .completed, .failed:
            EmptyView()
        }
    }

    private func recording(startedAt: Date, cleanup: Bool) -> some View {
        row {
            VoiceRecordingDot(paused: voice.cancelArmed)
            HStack(spacing: 8) {
                VoiceLevelMeter(level: voice.level)
                VoiceRecordingClock(startedAt: startedAt)
            }
            .opacity(voice.cancelArmed ? 0.35 : 1)
            .animation(.easeOut(duration: 0.18), value: voice.cancelArmed)

            Button {
                voice.setCleanup(!cleanup)
            } label: {
                Text("Cleanup \(cleanup ? "on" : "off")")
                    .font(T3Typography.supporting)
                    .foregroundStyle(cleanup ? T3Colors.danger : T3Colors.textSecondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(
                        cleanup ? T3Colors.danger.opacity(0.12) : T3Colors.subtle,
                        in: Capsule()
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Transcript cleanup")
            .accessibilityValue(cleanup ? "On" : "Off")

            Spacer(minLength: 0)

            if voice.holdActive {
                // Both labels name what releasing right now does, because
                // release is the only thing that decides: wandering into the
                // cancel zone arms the target, it does not discard.
                Text(voice.cancelArmed ? "Release to cancel" : "Release to send")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .accessibilityIdentifier("voice-hold-hint")
            } else {
                cancelButton(label: "Cancel recording")
            }
        }
        .accessibilityIdentifier("voice-recording-bar")
    }

    private func cancelButton(label: String) -> some View {
        Button {
            voice.cancelRecording()
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(T3Colors.textSecondary)
                .frame(width: 26, height: 26)
                .background(T3Colors.subtle, in: Circle())
                .frame(height: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func row(@ViewBuilder _ content: () -> some View) -> some View {
        HStack(spacing: 8) {
            content()
        }
        .frame(minHeight: 26)
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }
}

/// The dome-shaped dictation meter. Alternating response exponents keep
/// neighbouring bars from moving in lockstep, so it reads as a live waveform
/// rather than one block.
private struct VoiceLevelMeter: View {
    let level: Double

    private static let barCount = 14
    private static let maximumHeight: CGFloat = 16
    private static let minimumHeight: CGFloat = 3

    private static let profiles: [(weight: Double, exponent: Double, opacity: Double)] = {
        (0..<barCount).map { index in
            let centered = sin(Double.pi * (Double(index) + 0.5) / Double(barCount))
            return (
                weight: 0.3 + 0.7 * centered,
                exponent: index.isMultiple(of: 2) ? 0.8 : 1.3,
                opacity: 0.5 + 0.5 * centered
            )
        }
    }()

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(Self.profiles.enumerated()), id: \.offset) { index, profile in
                Capsule()
                    .fill(T3Colors.danger)
                    .frame(width: 3, height: height(for: profile))
                    .opacity(profile.opacity)
                    // Fast attack, slow release gives the meter a speech envelope.
                    .animation(
                        .easeOut(duration: index.isMultiple(of: 2) ? 0.06 : 0.09),
                        value: level
                    )
            }
        }
        .frame(height: Self.maximumHeight)
        .accessibilityHidden(true)
    }

    private func height(for profile: (weight: Double, exponent: Double, opacity: Double)) -> CGFloat {
        let clamped = min(1, max(0, level))
        let value = min(1, pow(clamped, profile.exponent) * profile.weight)
        return Self.minimumHeight + CGFloat(value) * (Self.maximumHeight - Self.minimumHeight)
    }
}

private struct VoiceRecordingDot: View {
    let paused: Bool
    @SwiftUI.Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dimmed = false

    var body: some View {
        Circle()
            .fill(T3Colors.danger)
            .frame(width: 6, height: 6)
            .opacity(dimmed ? 0.35 : 1)
            .accessibilityHidden(true)
            .onAppear { updatePulse() }
            .onChange(of: still) { updatePulse() }
    }

    /// Slide-to-cancel armed reuses the reduced-motion static path: the pulse
    /// stops while the release would discard the recording.
    private var still: Bool { paused || reduceMotion }

    private func updatePulse() {
        guard !still else {
            withAnimation(.linear(duration: 0.1)) { dimmed = false }
            return
        }
        withAnimation(.easeInOut(duration: 0.85).repeatForever(autoreverses: true)) {
            dimmed = true
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
                .foregroundStyle(T3Colors.danger)
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
