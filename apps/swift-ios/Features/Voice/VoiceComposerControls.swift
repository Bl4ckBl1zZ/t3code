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

/// The geometry shared between the combo button and the recording bar.
///
/// The two are never in the tree at the same time — the button carries an
/// invisible proxy while nothing is being recorded and the bar carries the real
/// capsule while something is — so `matchedGeometryEffect` reads it as one
/// shape moving, and the bar grows out of the button instead of appearing
/// beside it.
enum VoiceMorph {
    static let surfaceID = "voice.morph.surface"

    /// Physical rather than timed: the surface is a thing being pushed, so it
    /// settles with a little overshoot instead of decelerating to a stop.
    static let surface = Animation.spring(response: 0.42, dampingFraction: 0.78)
    static let control = Animation.spring(response: 0.32, dampingFraction: 0.66)
    static let armed = Animation.spring(response: 0.26, dampingFraction: 0.55)

    /// Reduce Motion keeps every state change legible, but as a cross-fade: no
    /// travel, no overshoot, no repeating pulse.
    static let reduced = Animation.easeInOut(duration: 0.18)

    /// The animation the composer wraps the bar's appearance in. Both halves of
    /// the morph have to change inside one transaction for the shared shape to
    /// interpolate, so the owner of both drives it.
    static func appearance(reduceMotion: Bool) -> Animation {
        reduceMotion ? reduced : surface
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
    /// Shared with `VoiceRecordingBar` so the two halves of the morph can find
    /// each other.
    let morphNamespace: Namespace.ID
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

    /// Armed only counts while there is audio to throw away; the gesture arms on
    /// travel alone, and a swipe over a button that never started recording
    /// should not turn red.
    private var isCancelArmed: Bool {
        voice.cancelArmed && voice.state.isRecording
    }

    /// The recording bar owns the shared shape whenever Voice Input is doing
    /// something, which is exactly when the bar renders.
    private var barOwnsSurface: Bool {
        voice.state.isBusy
    }

    private var symbol: String {
        isCancelArmed ? "xmark" : appearance.systemImage
    }

    /// Cancel-arm inverts the button rather than recolouring it: the fill drops
    /// out and the danger colour moves to the rim and the glyph, so "let go and
    /// this is gone" reads as the control emptying out. The solid cancel target
    /// floating above it stays the filled one of the pair.
    private var fill: Color {
        if isCancelArmed { return T3Colors.danger.opacity(0.16) }
        return appearance.isDanger ? T3Colors.danger : T3Colors.accent
    }

    private var foreground: Color {
        isCancelArmed ? T3Colors.danger : .white
    }

    private var scale: CGFloat {
        if reduceMotion { return 1 }
        if isCancelArmed { return 1.08 }
        if isPressed { return 0.94 }
        return 1
    }

    private var surface: some View {
        Group {
            if isSending {
                ProgressView()
                    .controlSize(.small)
                    .tint(.white)
            } else {
                Image(systemName: symbol)
                    .font(.system(size: symbol == "arrow.up" ? 14 : 15, weight: .bold))
                    // Reduce Motion swaps glyphs by dissolving them rather than
                    // by animating strokes in and out.
                    .contentTransition(
                        reduceMotion ? ContentTransition.opacity : .symbolEffect(.replace)
                    )
            }
        }
        .foregroundStyle(foreground)
        .frame(width: 34, height: 34)
        .background(fill, in: Circle())
        .overlay {
            Circle()
                .stroke(T3Colors.danger, lineWidth: 2)
                .opacity(isCancelArmed ? 1 : 0)
        }
        .background {
            // The hold's own halo. Static — it marks that the finger owns the
            // control, it does not need to breathe to say so.
            Circle()
                .stroke(T3Colors.danger.opacity(0.28), lineWidth: 3)
                .scaleEffect(voice.holdActive ? 1.24 : 1)
                .opacity(voice.holdActive ? 1 : 0)
        }
        .background {
            // The idle half of the morph: invisible, and present only while the
            // recording bar is not, so exactly one source ever claims the id.
            if !barOwnsSurface, !reduceMotion {
                Color.clear
                    .matchedGeometryEffect(id: VoiceMorph.surfaceID, in: morphNamespace)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            // The visual hint that holding the send button still dictates.
            if symbol == "arrow.up" {
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
        .scaleEffect(scale)
        .animation(reduceMotion ? VoiceMorph.reduced : VoiceMorph.control, value: isPressed)
        .animation(reduceMotion ? VoiceMorph.reduced : VoiceMorph.armed, value: isCancelArmed)
        .animation(reduceMotion ? VoiceMorph.reduced : VoiceMorph.control, value: voice.holdActive)
        .animation(VoiceMorph.appearance(reduceMotion: reduceMotion), value: appearance)
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

    @SwiftUI.Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if holdActive {
            Image(systemName: "xmark")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(cancelArmed ? Color.white : T3Colors.textSecondary)
                .frame(width: 32, height: 32)
                .background {
                    ZStack {
                        Color.clear.t3GlassEffect(.clear, in: Circle())
                        Circle()
                            .fill(T3Colors.danger)
                            .opacity(cancelArmed ? 1 : 0)
                    }
                }
                .overlay {
                    Circle().stroke(
                        cancelArmed ? T3Colors.danger : T3Colors.border,
                        lineWidth: 1
                    )
                }
                // Reduce Motion keeps the target at its resting size: proximity
                // is already carried by the colour flip on arm.
                .scaleEffect(reduceMotion ? 1 : 0.75 + 0.45 * min(max(progress, 0), 1))
                .animation(reduceMotion ? nil : VoiceMorph.control, value: progress)
                .animation(reduceMotion ? VoiceMorph.reduced : VoiceMorph.armed, value: cancelArmed)
                .transition(
                    reduceMotion ? .opacity : .scale.combined(with: .opacity)
                )
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
    /// Shared with `VoiceComboButton`; see `VoiceMorph`.
    let morphNamespace: Namespace.ID

    @SwiftUI.Environment(\.accessibilityReduceMotion) private var reduceMotion
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if voice.state.isBusy {
            content
                .background { morphSurface }
                .padding(.horizontal, 6)
                .padding(.bottom, 2)
                .transition(barTransition)
        }
    }

    @ViewBuilder
    private var content: some View {
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
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
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
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                Spacer(minLength: 0)
                cancelButton(label: "Cancel transcription")
            }
        case .idle, .completed, .failed:
            EmptyView()
        }
    }

    /// The recording half of the shared shape. Glass because this is a control
    /// surface that has just been pushed out over the draft, which is what the
    /// system material is for.
    private var morphSurface: some View {
        Color.clear
            .t3GlassEffect(.regular, in: capsule)
            .overlay { capsule.stroke(T3Colors.border, lineWidth: 1) }
            .modifier(
                VoiceMorphSource(
                    id: VoiceMorph.surfaceID,
                    namespace: morphNamespace,
                    // Reduce Motion cross-fades the bar in instead of growing
                    // it out of the button, so nothing needs to be matched.
                    isEnabled: !reduceMotion
                )
            )
    }

    private var capsule: Capsule {
        Capsule(style: .continuous)
    }

    /// Anchored at the button it came from, so the growth reads as directional
    /// rather than as a panel fading in.
    private var barTransition: AnyTransition {
        reduceMotion
            ? .opacity
            : .scale(scale: 0.9, anchor: .bottomTrailing).combined(with: .opacity)
    }

    /// The order the row gives width away in, from first to last: the meter,
    /// then the spacer, then each label's own scale factor, and only then a
    /// truncation.
    ///
    /// It used to be the reverse. The meter was rigid at fourteen 3-point bars
    /// and the spacer swallowed every spare point, so the first thing the layout
    /// could take width from was the labels. Measured against the composer's
    /// 380-point interior on a 440-point phone, the old row wanted 397 points at
    /// xxLarge and 424 at xxxLarge — which is where "Release to s…" came from —
    /// while the same row now compresses to 352 and 379.
    ///
    /// Past that, no arrangement of one line works: at AX5 the hint, the clock
    /// and the cleanup pill are 327, 110 and 234 points on their own. So at
    /// accessibility sizes the bar becomes two lines — what is happening, then
    /// what releasing will do — which fits every size with room to spare.
    private func recording(startedAt: Date, cleanup: Bool) -> some View {
        let stacked = dynamicTypeSize.isAccessibilitySize
        let spacing: CGFloat = stacked ? 6 : 8
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: spacing) {
                VoiceRecordingDot(paused: voice.cancelArmed)
                    .layoutPriority(1)

                // Dropped rather than crushed on the stacked layout: it is
                // decorative — `accessibilityHidden` already — and those are the
                // sizes where every point belongs to the labels.
                if !stacked {
                    VoiceLevelMeter(level: voice.level, reduceMotion: reduceMotion)
                        .modifier(
                            VoiceArmedDimming(armed: voice.cancelArmed, reduced: reduceMotion)
                        )
                }

                VoiceRecordingClock(startedAt: startedAt)
                    .modifier(VoiceArmedDimming(armed: voice.cancelArmed, reduced: reduceMotion))
                    .layoutPriority(1)

                cleanupToggle(cleanup)
                    .layoutPriority(1)

                Spacer(minLength: 0)

                if !stacked {
                    releaseAffordance.layoutPriority(2)
                }
            }

            if stacked {
                HStack(spacing: spacing) {
                    releaseAffordance
                    Spacer(minLength: 0)
                }
            }
        }
        .frame(minHeight: 26)
        .padding(.horizontal, stacked ? 10 : 12)
        .padding(.vertical, 5)
        .accessibilityIdentifier("voice-recording-bar")
    }

    private func cleanupToggle(_ cleanup: Bool) -> some View {
        Button {
            voice.setCleanup(!cleanup)
        } label: {
            Text("Cleanup \(cleanup ? "on" : "off")")
                .font(T3Typography.supporting)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
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
    }

    /// What releasing right now does — or, hands-free, the way out.
    @ViewBuilder
    private var releaseAffordance: some View {
        if voice.holdActive {
            // Both labels name what releasing right now does, because release is
            // the only thing that decides: wandering into the cancel zone arms
            // the target, it does not discard. Which makes this the last thing
            // in the row that may be shortened, and the reason it scales down
            // before it truncates.
            Text(voice.cancelArmed ? "Release to cancel" : "Release to send")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .accessibilityIdentifier("voice-hold-hint")
        } else {
            cancelButton(label: "Cancel recording")
        }
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
        HStack(spacing: dynamicTypeSize.isAccessibilitySize ? 6 : 8) {
            content()
        }
        .frame(minHeight: 26)
        .padding(.horizontal, dynamicTypeSize.isAccessibilitySize ? 10 : 12)
        .padding(.vertical, 5)
    }
}

/// Dims what slide-to-cancel is about to throw away. Applied per element rather
/// than to a wrapping `HStack`, because grouping the meter with the clock made
/// the pair rigid and cost the row the one control it can take width from.
private struct VoiceArmedDimming: ViewModifier {
    let armed: Bool
    let reduced: Bool

    func body(content: Content) -> some View {
        content
            .opacity(armed ? 0.35 : 1)
            .animation(reduced ? VoiceMorph.reduced : VoiceMorph.armed, value: armed)
    }
}

/// `matchedGeometryEffect` has no "off" switch, and applying it conditionally
/// inside a `ViewBuilder` would change the view's identity — which is the one
/// thing that breaks the morph. Wrapping it in a modifier keeps the identity
/// stable while Reduce Motion opts out of the matching.
private struct VoiceMorphSource: ViewModifier {
    let id: String
    let namespace: Namespace.ID
    let isEnabled: Bool

    func body(content: Content) -> some View {
        if isEnabled {
            content.matchedGeometryEffect(id: id, in: namespace)
        } else {
            content
        }
    }
}

/// Interpolates the level samples the recorder publishes every 100 ms into a
/// continuous value.
///
/// Attack is quick and release is slow, which is the shape of a speech
/// envelope; without it the meter steps ten times a second and reads as a
/// progress bar rather than as a microphone.
struct VoiceLevelEnvelope: Equatable {
    /// Where the displayed value was when the current sample arrived.
    private(set) var previous: Double
    private(set) var target: Double
    private(set) var changedAt: TimeInterval

    static let attackSeconds: TimeInterval = 0.07
    static let releaseSeconds: TimeInterval = 0.26

    init(previous: Double = 0, target: Double = 0, changedAt: TimeInterval = 0) {
        self.previous = previous
        self.target = target
        self.changedAt = changedAt
    }

    func value(at time: TimeInterval) -> Double {
        let span = target >= previous ? Self.attackSeconds : Self.releaseSeconds
        guard span > 0 else { return target }
        let progress = min(1, max(0, (time - changedAt) / span))
        // Smoothstep leaves and arrives with zero slope, so consecutive samples
        // join without the corner a linear ramp would leave behind.
        let eased = progress * progress * (3 - 2 * progress)
        return previous + (target - previous) * eased
    }

    /// Retargets from wherever the glide had reached, so a sample landing
    /// mid-flight bends the curve instead of restarting it.
    func retargeted(to level: Double, at time: TimeInterval) -> VoiceLevelEnvelope {
        VoiceLevelEnvelope(
            previous: value(at: time),
            target: min(1, max(0, level)),
            changedAt: time
        )
    }
}

/// The dome-shaped dictation meter's geometry. Alternating response exponents
/// keep neighbouring bars from moving in lockstep, so it reads as a live
/// waveform rather than one block.
///
/// The bar count is a range rather than a constant because the meter is the
/// recording bar's slack: it is the only element in that row that loses no
/// information by being narrower, so it is what gives way when the row runs out
/// of width — the labels beside it must not.
enum VoiceLevelMeterGeometry {
    struct Profile: Equatable {
        let weight: Double
        let exponent: Double
        let opacity: Double
    }

    /// The meter at full width.
    static let barCount = 14
    /// Fewer than this and the dome stops reading as a waveform.
    static let minimumBarCount = 5
    static let barWidth: CGFloat = 3
    static let barSpacing: CGFloat = 2
    static let maximumHeight: CGFloat = 16
    static let minimumHeight: CGFloat = 3

    static let profiles: [Profile] = profiles(count: barCount)

    static var maximumWidth: CGFloat { width(barCount: barCount) }
    static var minimumWidth: CGFloat { width(barCount: minimumBarCount) }

    static func width(barCount: Int) -> CGFloat {
        guard barCount > 0 else { return 0 }
        return CGFloat(barCount) * barWidth + CGFloat(barCount - 1) * barSpacing
    }

    /// How many bars fit in `width`, clamped to the range the meter stays
    /// legible in. A width below `minimumWidth` still renders the minimum count
    /// rather than collapsing, because the frame that hands the width in never
    /// proposes less than that.
    static func barCount(fitting width: CGFloat) -> Int {
        guard width.isFinite, width > 0 else { return minimumBarCount }
        let fitted = Int((width + barSpacing) / (barWidth + barSpacing))
        return min(barCount, max(minimumBarCount, fitted))
    }

    /// Precomputed for every count the meter can render at, so resizing during a
    /// recording never runs trigonometry per frame per bar.
    private static let profilesByCount: [Int: [Profile]] = Dictionary(
        uniqueKeysWithValues: (minimumBarCount...barCount).map { ($0, makeProfiles(count: $0)) }
    )

    static func profiles(count: Int) -> [Profile] {
        profilesByCount[clampedCount(count)] ?? makeProfiles(count: clampedCount(count))
    }

    /// `phase` is a monotonically increasing time in seconds. It walks a slow
    /// ripple along the dome so a sustained level still moves, and the ripple is
    /// scaled by the level itself so silence stays flat instead of inventing
    /// motion that no one is making.
    static func height(
        level: Double,
        phase: Double,
        index: Int,
        count: Int = barCount
    ) -> CGFloat {
        let table = profiles(count: count)
        let profile = table[min(max(index, 0), table.count - 1)]
        let clamped = min(1, max(0, level))
        let ripple = 1 + 0.22 * clamped * sin(2 * .pi * phase * 1.15 - Double(index) * 0.52)
        let value = min(1, max(0, pow(clamped, profile.exponent) * profile.weight * ripple))
        return minimumHeight + CGFloat(value) * (maximumHeight - minimumHeight)
    }

    private static func clampedCount(_ count: Int) -> Int {
        min(barCount, max(minimumBarCount, count))
    }

    /// The dome is described in normalized position, so it keeps its shape at
    /// every width instead of being a fixed 14-bar curve with the ends chopped.
    private static func makeProfiles(count: Int) -> [Profile] {
        (0..<count).map { index in
            let centered = sin(Double.pi * (Double(index) + 0.5) / Double(count))
            return Profile(
                weight: 0.3 + 0.7 * centered,
                exponent: index.isMultiple(of: 2) ? 0.8 : 1.3,
                opacity: 0.5 + 0.5 * centered
            )
        }
    }
}

/// The dictation meter, sized to whatever width the row can spare.
///
/// Deliberately the only flexible-width element in the recording bar: it reports
/// a minimum well below its ideal, so the layout takes width from here — one or
/// two bars at a time — long before it starts truncating the labels that tell
/// the user what releasing will do.
private struct VoiceLevelMeter: View {
    let level: Double
    let reduceMotion: Bool

    @State private var envelope = VoiceLevelEnvelope()

    var body: some View {
        GeometryReader { proxy in
            let count = VoiceLevelMeterGeometry.barCount(fitting: proxy.size.width)
            Group {
                if reduceMotion {
                    // Same information, no motion: the bars show the sample that
                    // arrived, without interpolation or ripple.
                    bars(level: level, phase: 0, count: count)
                } else {
                    TimelineView(.animation) { context in
                        let now = context.date.timeIntervalSinceReferenceDate
                        bars(level: envelope.value(at: now), phase: now, count: count)
                    }
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .leading)
        }
        // `idealWidth` is spelled out because a `GeometryReader` has no
        // intrinsic size of its own; without it the row would lay the meter out
        // at the reader's 10-point placeholder.
        .frame(
            minWidth: VoiceLevelMeterGeometry.minimumWidth,
            idealWidth: VoiceLevelMeterGeometry.maximumWidth,
            maxWidth: VoiceLevelMeterGeometry.maximumWidth,
            minHeight: VoiceLevelMeterGeometry.maximumHeight,
            maxHeight: VoiceLevelMeterGeometry.maximumHeight
        )
        .accessibilityHidden(true)
        .onChange(of: level, initial: true) { _, newValue in
            envelope = envelope.retargeted(
                to: newValue,
                at: Date.timeIntervalSinceReferenceDate
            )
        }
    }

    private func bars(level: Double, phase: Double, count: Int) -> some View {
        let profiles = VoiceLevelMeterGeometry.profiles(count: count)
        return HStack(spacing: VoiceLevelMeterGeometry.barSpacing) {
            ForEach(0..<profiles.count, id: \.self) { index in
                Capsule()
                    .fill(T3Colors.danger)
                    .frame(
                        width: VoiceLevelMeterGeometry.barWidth,
                        height: VoiceLevelMeterGeometry.height(
                            level: level,
                            phase: phase,
                            index: index,
                            count: profiles.count
                        )
                    )
                    .opacity(profiles[index].opacity)
            }
        }
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
