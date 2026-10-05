import SwiftUI

// Ported in spirit from apps/mobile/src/features/voice-input/GlobalVoiceInputControl.tsx
// (upstream bf5c146be9): a dictation keeps running when its composer leaves
// the screen, and an edge pill keeps it visible and finishable from anywhere.

/// When the off-screen dictation pill shows, and what it offers. Kept apart
/// from the view so the rules are testable without rendering.
struct VoiceEdgePillPresentation: Equatable {
    let startedAt: Date
    /// The thread the recording belongs to, when the return button can lead
    /// back to it.
    let returnThreadID: String?
    /// False while a push-to-talk finger is down: the pill must never take a
    /// touch away from the composer's hold.
    let acceptsTouches: Bool

    /// Shown only while audio is being captured and no composer is on screen
    /// to show its own recording strip. Transcribing and failures stay with the
    /// composer, which the stash hands the transcript back to.
    static func resolve(
        state: VoiceInputState,
        hasVisibleComposer: Bool,
        holdActive: Bool,
        recordingThreadID: String?,
        threadExists: (String) -> Bool
    ) -> VoiceEdgePillPresentation? {
        guard let startedAt = state.recordingStartedAt, !hasVisibleComposer else { return nil }
        return VoiceEdgePillPresentation(
            startedAt: startedAt,
            returnThreadID: recordingThreadID.flatMap { threadExists($0) ? $0 : nil },
            acceptsTouches: !holdActive
        )
    }
}

/// The level bars' fixed shape. A few static bars scaled by the current level,
/// not a scrolling history: the pill repaints only when the meter publishes,
/// and nothing moves once the level settles.
enum VoiceEdgePillLevels {
    static let weights: [Double] = [0.55, 1, 0.75, 0.4]
    static let minimumHeight: CGFloat = 3
    static let maximumHeight: CGFloat = 14

    static func heights(level: Double) -> [CGFloat] {
        let clamped = min(1, max(0, level))
        // The same sub-linear lift as the composer waveform, so quiet speech
        // still visibly moves the bars.
        let lifted = pow(clamped, 0.7)
        return weights.map { weight in
            minimumHeight + CGFloat(lifted * weight) * (maximumHeight - minimumHeight)
        }
    }
}

/// The trailing-edge pill for a dictation whose composer is off screen: a red
/// recording dot, the elapsed clock, a few level bars, a return button that
/// opens the conversation the recording belongs to, and a stop button.
///
/// A separate overlay, never part of the composer's tree, so its appearance
/// cannot reset a push-to-talk hold.
struct VoiceEdgePill: View {
    let voice: VoiceComposerCoordinator
    let presentation: VoiceEdgePillPresentation
    let onReturn: (String) -> Void

    @ScaledMetric(relativeTo: .body) private var buttonSize: CGFloat = 30

    private var shape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: 22,
            bottomLeadingRadius: 22,
            bottomTrailingRadius: 0,
            topTrailingRadius: 0,
            style: .continuous
        )
    }

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(T3Colors.danger)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
            VoiceRecordingClock(startedAt: presentation.startedAt)
            VoiceEdgePillLevelBars(voice: voice)
            if let threadID = presentation.returnThreadID {
                Button {
                    onReturn(threadID)
                } label: {
                    Image(systemName: "arrow.uturn.backward")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(T3Colors.textPrimary)
                        .frame(width: buttonSize, height: buttonSize)
                        .background(T3Colors.subtleStrong, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Return to dictation")
                .accessibilityHint("Opens the conversation this recording belongs to")
                .accessibilityIdentifier("voice-edge-return")
            }
            Button {
                voice.stopOffScreen()
            } label: {
                Image(systemName: "stop.fill")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(T3Colors.primaryActionForeground)
                    .frame(width: buttonSize, height: buttonSize)
                    .background(T3Colors.primaryAction, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop recording and transcribe")
            .accessibilityIdentifier("voice-edge-stop")
        }
        .padding(.leading, 14)
        .padding(.trailing, 10)
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .t3GlassEffect(.regular, in: shape)
        .t3GlassRim(in: shape)
        .allowsHitTesting(presentation.acceptsTouches)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Dictation in progress")
        .accessibilityIdentifier("voice-edge-pill")
    }
}

/// Its own view so a level sample invalidates only the bars, not the pill.
private struct VoiceEdgePillLevelBars: View {
    let voice: VoiceComposerCoordinator

    var body: some View {
        HStack(spacing: 2.5) {
            ForEach(Array(VoiceEdgePillLevels.heights(level: voice.level).enumerated()), id: \.offset) { _, height in
                Capsule()
                    .fill(T3Colors.textPrimary)
                    .frame(width: 2.5, height: height)
            }
        }
        .frame(height: VoiceEdgePillLevels.maximumHeight)
        .accessibilityHidden(true)
    }
}

/// Hosts the edge pill over Home. Its own view so recording, visibility and
/// hold changes re-evaluate only this, never the screen it floats over.
struct VoiceEdgePillHost: View {
    let voice: VoiceComposerCoordinator
    let threadExists: (String) -> Bool
    let onReturn: (String) -> Void

    @SwiftUI.Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let presentation = VoiceEdgePillPresentation.resolve(
            state: voice.state,
            hasVisibleComposer: voice.hasVisibleComposer,
            holdActive: voice.holdActive,
            recordingThreadID: voice.recordingThreadID,
            threadExists: threadExists
        )
        ZStack(alignment: .bottomTrailing) {
            if let presentation {
                VoiceEdgePill(voice: voice, presentation: presentation, onReturn: onReturn)
                    // Slides in from the edge it docks to; Reduce Motion keeps
                    // it to a cross-fade.
                    .transition(
                        reduceMotion ? .opacity : .move(edge: .trailing).combined(with: .opacity)
                    )
            }
        }
        .animation(VoiceMorph.appearance(reduceMotion: reduceMotion), value: presentation != nil)
    }
}
