import SwiftUI

/// The live line the composer wears while a turn is in flight: what the agent
/// is doing right now, and how long it has been at it.
///
/// This replaces the "Agent is working / New output will appear here" row that
/// used to sit at the tail of the transcript. That row scrolled away the moment
/// the reader moved up the thread, cost two lines to say nothing, and claimed
/// the agent was working while the run was still being prepared. The status
/// belongs to the bottom chrome instead: it cannot be scrolled off, it sits
/// beside the stop button it invites, and every word in it changes as the run
/// moves.
struct ThreadWorkingStatus: Equatable, Sendable {
    /// What the agent is doing, in the same words the work log uses for the row
    /// it will leave behind.
    let headline: String
    let symbolName: String
    /// When the run started, for the elapsed timer. Nil until the server
    /// reports a start, which hides the timer rather than counting from now.
    let startedAt: Date?

    /// Below this a timer is noise: a turn that answers in six seconds should
    /// not flash a stopwatch on its way past.
    private static let minimumTimedDuration: TimeInterval = 10

    /// The same compact form Home rows use, so a thread reads the same in the
    /// list and in its own transcript.
    func durationLabel(at now: Date) -> String? {
        guard let startedAt,
              now.timeIntervalSince(startedAt) >= Self.minimumTimedDuration else { return nil }
        return HomeWorkingDuration.compact(since: startedAt, now: now)
    }

    /// Nil for every state that is not a turn in flight.
    ///
    /// Approval and input are deliberately absent: the composer swaps itself for
    /// the approval or input panel in those states, so a line above it saying
    /// "Approval needed" would name the panel already filling the screen.
    static func resolve(
        state: FeatureThreadState,
        workingStartedAt: Date?,
        timelineItems: [OrchestrationV2ProjectedTurnItem],
        activeRunID: String?
    ) -> ThreadWorkingStatus? {
        switch state {
        case .idle, .waitingForApproval, .waitingForInput, .failed, .completed:
            return nil
        case .queued:
            // `queued` covers preparing, queued and starting: the run exists but
            // has produced nothing, and calling that "working" is what made the
            // old indicator lie.
            return ThreadWorkingStatus(
                headline: "Starting agent",
                symbolName: "circle.dotted",
                startedAt: workingStartedAt
            )
        case .working:
            guard let live = liveItem(in: timelineItems, activeRunID: activeRunID) else {
                return ThreadWorkingStatus(
                    headline: "Thinking",
                    symbolName: "circle.dotted",
                    startedAt: workingStartedAt
                )
            }
            return ThreadWorkingStatus(
                headline: headline(for: live),
                symbolName: symbolName(for: live),
                startedAt: workingStartedAt
            )
        }
    }

    /// The newest item still running, which is the one the reader would point at
    /// if asked what the agent is doing.
    ///
    /// Scoped to the active run when the projection names one, so an item left
    /// unterminated by an interrupted run cannot keep reporting.
    private static func liveItem(
        in timelineItems: [OrchestrationV2ProjectedTurnItem],
        activeRunID: String?
    ) -> OrchestrationV2ProjectedTurnItem? {
        timelineItems.last { projected in
            let item = projected.item
            guard !item.status.isTerminal else { return false }
            if let activeRunID, item.base.runId != activeRunID { return false }
            return ThreadWorkLogPresentation.isToolLike(item) || item.type == "assistant_message"
        }
    }

    private static func headline(for projected: OrchestrationV2ProjectedTurnItem) -> String {
        guard projected.item.type != "assistant_message" else { return "Writing a reply" }
        return ThreadWorkLogRow.make(projected).summary
    }

    private static func symbolName(for projected: OrchestrationV2ProjectedTurnItem) -> String {
        guard projected.item.type != "assistant_message" else { return "text.alignleft" }
        return ThreadWorkLogRow.make(projected).icon.symbolName
    }
}

/// The status line inside the composer's glass, above the draft field.
///
/// It lives in the pill rather than in the transcript so it rides the keyboard,
/// survives scrolling, and shares the composer's shape instead of floating as a
/// second surface over the conversation.
struct ThreadWorkingStatusBar: View {
    let status: ThreadWorkingStatus

    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        // The only thing on this line that is a function of time is the timer,
        // so a status with no start to count from renders once and stays put.
        if status.startedAt == nil {
            row(at: .now)
        } else {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                row(at: context.date)
            }
        }
    }

    private func row(at now: Date) -> some View {
        // At accessibility sizes the headline needs the whole width; the timer
        // is the first thing to go, and the thread header still carries state.
        let duration = dynamicTypeSize.isAccessibilitySize ? nil : status.durationLabel(at: now)
        return HStack(spacing: 8) {
            Image(systemName: status.symbolName)
                .font(T3Typography.supporting.weight(.semibold))
                .foregroundStyle(T3Colors.statusRunning)
                .frame(width: 16)

            Text(status.headline)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .lineLimit(1)
                // A path loses its meaning from the front, never from the back.
                .truncationMode(.middle)

            Spacer(minLength: 8)

            if let duration {
                Text(duration)
                    .font(T3Typography.supporting)
                    .monospacedDigit()
                    .foregroundStyle(T3Colors.textTertiary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        // A rectangle, not a rounded one: the composer clips this to its own
        // shape, which is what fuses the band to the top of the pill.
        .background(T3Colors.statusRunning.opacity(0.08))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            duration == nil
                ? "Agent is working. \(status.headline)."
                : "Agent is working. \(status.headline). \(duration ?? "")."
        )
        .accessibilityIdentifier("thread-working-status")
    }
}
