import SwiftUI

/// The floating bar above the transcript: agents on the left, background work on
/// the right.
///
/// Both halves answer the same question — what is happening while you are
/// reading something else — which is why they share one line rather than
/// competing for the top of the screen. They stay separate capsules because they
/// open separate sheets; see `ThreadBackgroundTasksCapsule`.
///
/// The bar owns its own visibility rather than leaving it to the host. A lingering
/// failure expires on a clock, and a host that decided visibility once per body
/// would leave the capsule stranded on screen until some unrelated change forced
/// a redraw. Deciding it inside the timeline means the bar disappears on the same
/// tick the linger window closes, and the height preference the transcript reads
/// for its top inset collapses to zero with it.
struct TranscriptStatusBar: View {
    let relationships: ThreadRelationshipsModel?
    let backgroundCommands: [ThreadDetailsBackgroundCommand]
    let onOpenThread: (_ threadID: String, _ isArchived: Bool) -> Void
    let onMerge: () async -> Bool
    let onDetach: () async -> Void

    var body: some View {
        if backgroundCommands.isEmpty {
            // Nothing on this bar is a function of time, so there is nothing for
            // a timeline to drive. The agents capsule redraws when its own model
            // changes, and this is the overwhelmingly common case.
            bar(summary: .empty, processes: [], nowMilliseconds: 0)
        } else {
            TimelineView(.periodic(from: .now, by: tickInterval)) { context in
                let now = Int(context.date.timeIntervalSince1970 * 1000)
                bar(
                    summary: ThreadDetailsBackgroundTasks.summary(
                        commands: backgroundCommands, nowMilliseconds: now
                    ),
                    processes: ThreadDetailsBackgroundTasks.capsuleProcesses(
                        commands: backgroundCommands, nowMilliseconds: now
                    ),
                    nowMilliseconds: now
                )
            }
        }
    }

    @ViewBuilder
    private func bar(
        summary: ThreadBackgroundSummary,
        processes: [ThreadDetailsBackgroundProcess],
        nowMilliseconds: Int
    ) -> some View {
        let showsAgents = relationships?.showsCollapsedBanner == true
        if showsAgents || !summary.isEmpty {
            T3GlassContainer(spacing: 8) {
                HStack(spacing: 8) {
                    if showsAgents, let relationships {
                        ThreadRelationshipsBanner(
                            model: relationships,
                            onOpenThread: onOpenThread,
                            onMerge: onMerge,
                            onDetach: onDetach
                        )
                    } else {
                        // A lone background capsule keeps the trailing edge it
                        // holds when the agents capsule is there; sliding to the
                        // left as agents finish would read as a different control.
                        Spacer(minLength: 0)
                    }

                    if !summary.isEmpty {
                        ThreadBackgroundTasksCapsule(
                            summary: summary,
                            nowMilliseconds: nowMilliseconds,
                            processes: processes
                        )
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
    }

    /// Sampled outside the timeline, the way `ThreadDetailsBackgroundTaskRow`
    /// does it: a schedule is fixed when the view is built, so the cadence has to
    /// come from a clock read here rather than from the context it configures.
    private var tickInterval: TimeInterval {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let summary = ThreadDetailsBackgroundTasks.summary(
            commands: backgroundCommands, nowMilliseconds: now
        )
        return TimeInterval(
            ThreadDetailsBackgroundTasks.capsuleTickSeconds(summary, nowMilliseconds: now)
        )
    }
}
