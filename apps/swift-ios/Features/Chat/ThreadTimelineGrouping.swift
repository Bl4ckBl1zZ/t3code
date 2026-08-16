import Foundation

// Ported from the grouping half of apps/mobile/src/lib/threadActivity.ts
// (`mergeRelatedThreadCardRuns`, `mergeAgentUpdateRuns`). Both collapse a run of
// adjacent, identically shaped entries into one container; singles keep their
// ordinary presentation.

/// A maximal run of adjacent entries that present as one container, or a single
/// entry that presents on its own.
public struct ThreadTimelineGroup<Element>: Identifiable {
    public let id: String
    public let elements: [Element]

    /// False for a run of one — the caller renders the element as it always
    /// would rather than wrapping a lone card in a group surface.
    public var isGrouped: Bool { elements.count > 1 }

    /// Valid for every group: a group always has at least one element.
    public var first: Element { elements[0] }
}

extension ThreadTimelineGroup: Equatable where Element: Equatable {}

public enum ThreadTimelineGrouping {
    /// The lifecycle items that render as a bordered related-thread card.
    /// Dividers and interrupt lines are not cards and never join a group.
    static let relatedThreadCardTypes: Set<String> = ["subagent", "thread_created"]

    public static func isRelatedThreadCard(_ item: OrchestrationV2TurnItem) -> Bool {
        relatedThreadCardTypes.contains(item.type)
    }

    /// A prompt the orchestrator wrote on the user's behalf — a delegated-task
    /// wake or another injected instruction.
    public static func isAgentUpdate(_ item: OrchestrationV2TurnItem) -> Bool {
        guard case .userMessage = item.payload else { return false }
        return item.base.createdBy == "agent"
    }

    /// Collapses maximal runs of two or more consecutive members into one
    /// group. Non-members and lone members pass through as groups of one, so
    /// the result is still the whole timeline in order.
    ///
    /// - Parameter groupIDPrefix: Group ids are anchored to the first member
    ///   (`"\(prefix):\(firstID)"`) so the id stays stable as later entries join
    ///   the run — an id that moved with the last entry would remount the group
    ///   on every append.
    public static func mergeRuns<Element>(
        _ elements: [Element],
        groupIDPrefix: String,
        id: (Element) -> String,
        isMember: (Element) -> Bool
    ) -> [ThreadTimelineGroup<Element>] {
        var result: [ThreadTimelineGroup<Element>] = []
        var index = 0
        while index < elements.count {
            let element = elements[index]
            guard isMember(element) else {
                result.append(ThreadTimelineGroup(id: id(element), elements: [element]))
                index += 1
                continue
            }
            var run = [element]
            var next = index + 1
            while next < elements.count, isMember(elements[next]) {
                run.append(elements[next])
                next += 1
            }
            if run.count < 2 {
                result.append(ThreadTimelineGroup(id: id(element), elements: run))
            } else {
                result.append(
                    ThreadTimelineGroup(
                        id: "\(groupIDPrefix):\(id(element))",
                        elements: run
                    )
                )
            }
            index = next
        }
        return result
    }

    /// Consecutive related-thread cards (a fan-out of subagents, say) are
    /// identically shaped boxes stacked with a gap between them. They read as
    /// one list, so a run collapses into a single card.
    public static func mergeRelatedThreadCardRuns(
        _ rows: [OrchestrationV2ProjectedTurnItem]
    ) -> [ThreadTimelineGroup<OrchestrationV2ProjectedTurnItem>] {
        mergeRuns(
            rows,
            groupIDPrefix: "lifecycle-group",
            id: \.id,
            isMember: { isRelatedThreadCard($0.item) }
        )
    }

    /// Consecutive agent-authored prompts collapse into one "agent updates"
    /// group — a run of near-identical machine callbacks shouldn't occupy a
    /// bubble each.
    public static func mergeAgentUpdateRuns(
        _ rows: [OrchestrationV2ProjectedTurnItem]
    ) -> [ThreadTimelineGroup<OrchestrationV2ProjectedTurnItem>] {
        mergeRuns(
            rows,
            groupIDPrefix: "agent-updates",
            id: \.id,
            isMember: { isAgentUpdate($0.item) }
        )
    }
}
