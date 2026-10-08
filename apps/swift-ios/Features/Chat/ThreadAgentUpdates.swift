import SwiftUI
import UIKit

/// The wake the orchestrator sends a parent thread when a delegated task
/// settles. Ported from packages/shared/src/delegatedTaskWake.ts so the
/// transcript shows "title — status" instead of the task_status boilerplate.
/// Anything that does not match renders as the raw text.
struct DelegatedTaskWake: Equatable, Sendable {
    /// The task title, or the raw task id when the task was untitled.
    let title: String
    let taskID: String
    /// "completed", or the raw terminal status word (failed, cancelled, ...).
    let status: String

    private static let completed = try! NSRegularExpression(
        pattern: #"^Delegated task (?:"([\s\S]+)"|(\S+)) completed\. Use task_status with taskId (\S+) to read the result\.$"#
    )
    private static let ended = try! NSRegularExpression(
        pattern: #"^Delegated task (?:"([\s\S]+)"|(\S+)) ended with status (\S+)\. Use task_status with taskId (\S+) for details\.$"#
    )

    static func parse(_ text: String) -> DelegatedTaskWake? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let range = NSRange(trimmed.startIndex..., in: trimmed)
        func group(_ match: NSTextCheckingResult, _ index: Int) -> String? {
            Range(match.range(at: index), in: trimmed).map { String(trimmed[$0]) }
        }
        if let match = completed.firstMatch(in: trimmed, range: range) {
            return DelegatedTaskWake(
                title: group(match, 1) ?? group(match, 2) ?? "",
                taskID: group(match, 3) ?? "",
                status: "completed"
            )
        }
        if let match = ended.firstMatch(in: trimmed, range: range) {
            return DelegatedTaskWake(
                title: group(match, 1) ?? group(match, 2) ?? "",
                taskID: group(match, 4) ?? "",
                status: group(match, 3) ?? ""
            )
        }
        return nil
    }
}

/// A run of two or more consecutive agent-authored prompts, collapsed into one
/// row. Singles keep their ordinary bubble.
struct ThreadAgentUpdates: Equatable {
    struct Update: Equatable, Identifiable {
        let message: FeatureMessage
        /// Parsed once here rather than on every render of the row.
        let wake: DelegatedTaskWake?

        var id: String { message.id }

        /// What the update says in one line: the task's title, else its text.
        var title: String {
            if let wake { return wake.title }
            return message.text.split(whereSeparator: \.isNewline).first.map(String.init) ?? message.text
        }

        /// "Completed", "Failed": sentence case, like web's `capitalizePhrase`.
        var statusLabel: String? {
            guard let status = wake?.status.trimmingCharacters(in: .whitespaces), !status.isEmpty else { return nil }
            return status.prefix(1).uppercased() + status.dropFirst()
        }

        var isFailure: Bool { wake?.status == "failed" }
    }

    let id: String
    let updates: [Update]

    var date: Date? { updates.first?.message.createdAt }
    var latest: Update? { updates.last }
}

/// Ported from `mergeAgentUpdateRuns` in MessagesTimeline.logic.ts. Runs before
/// day dividers are inserted, like web, so a run never straddles one.
enum ThreadAgentUpdateGrouping {
    static func merge(_ entries: [ThreadTimelineEntry]) -> [ThreadTimelineEntry] {
        guard entries.contains(where: isAgentUpdate) else { return entries }
        return ThreadTimelineGrouping.mergeRuns(
            entries,
            groupIDPrefix: "agent-updates",
            id: \.id,
            isMember: isAgentUpdate
        )
        .map { group in
            guard group.isGrouped else { return group.first }
            let updates = group.elements.compactMap { entry -> ThreadAgentUpdates.Update? in
                guard case let .message(message, _) = entry else { return nil }
                return ThreadAgentUpdates.Update(message: message, wake: DelegatedTaskWake.parse(message.text))
            }
            return .structural(.agentUpdates(ThreadAgentUpdates(id: group.id, updates: updates)))
        }
    }

    private static func isAgentUpdate(_ entry: ThreadTimelineEntry) -> Bool {
        guard case let .message(message, _) = entry else { return false }
        return message.isAgentAuthored
    }
}

/// "Agent updates · latest · N", drawn like a settled work log's summary row.
/// Open, each update reads as its title and status; one an agent sent from
/// another thread opens that thread.
struct ThreadAgentUpdatesGroup: View {
    let updates: ThreadAgentUpdates
    let currentThreadID: String
    let onOpenThread: (String) -> Void

    @SwiftUI.Environment(\.threadWorkLogHistory) private var sharedHistory
    @State private var localHistory = ThreadWorkLogHistoryStore()

    /// Survives the cell being recycled, like a work log's own fold.
    private var history: ThreadWorkLogHistory {
        (sharedHistory ?? localHistory).entry("\(currentThreadID):\(updates.id)")
    }

    private var isExpanded: Bool { history.groupExpanded ?? false }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if isExpanded {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(updates.updates) { update in
                        AgentUpdateLine(update: update, onOpenThread: onOpenThread)
                    }
                }
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(ChatTimelineStyle.hairline)
                        .frame(width: 1)
                        .padding(.vertical, 4)
                        .accessibilityHidden(true)
                }
                .padding(.leading, 10)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, ChatTimelineStyle.entrySpacing)
    }

    private var header: some View {
        Button {
            withAnimation(.snappy) { history.groupExpanded = !isExpanded }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "person.2.wave.2")
                    .font(ChatTimelineStyle.small.weight(.medium))
                    .foregroundStyle(T3Colors.textTertiary)
                    .frame(width: 20)
                    .accessibilityHidden(true)
                Text(verbatim: "Agent updates")
                    .font(ChatTimelineStyle.bodyStrong)
                    .foregroundStyle(T3Colors.textPrimary)
                    .layoutPriority(1)
                if let latest = updates.latest {
                    Text(verbatim: latest.title)
                        .font(ChatTimelineStyle.body)
                        .foregroundStyle(T3Colors.textTertiary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Spacer(minLength: 0)
                }
                Text(verbatim: "\(updates.updates.count)")
                    .font(ChatTimelineStyle.small)
                    .monospacedDigit()
                    .foregroundStyle(T3Colors.textTertiary)
                TimelineDisclosureChevron(isExpanded: isExpanded)
            }
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(updates.updates.count) agent updates")
        .accessibilityValue([updates.latest.map { "Latest: \($0.title)" }, isExpanded ? "Expanded" : "Collapsed"]
            .compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(.isButton)
    }
}

/// One update: a delegated task's title and status, or the prompt's own text.
private struct AgentUpdateLine: View {
    let update: ThreadAgentUpdates.Update
    let onOpenThread: (String) -> Void

    private var senderThreadID: String? { update.message.senderThreadID }

    var body: some View {
        Group {
            if let senderThreadID {
                Button { onOpenThread(senderThreadID) } label: { line }
                    .buttonStyle(.plain)
            } else {
                line
            }
        }
        .contextMenu {
            if let senderThreadID {
                Button("Open Sending Thread", systemImage: "arrow.up.forward.square") { onOpenThread(senderThreadID) }
            }
            Button("Copy Text", systemImage: "doc.on.doc") { copy() }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(senderThreadID == nil ? "" : "Opens the thread that sent it.")
        .accessibilityAddTraits(senderThreadID == nil ? [] : .isButton)
        .accessibilityAction(named: "Copy text", copy)
    }

    private var line: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            content
                .frame(maxWidth: .infinity, alignment: .leading)
            if let status = update.statusLabel {
                Text(verbatim: status)
                    .font(ChatTimelineStyle.small)
                    .foregroundStyle(update.isFailure ? T3Colors.danger : T3Colors.textTertiary)
            }
            if senderThreadID != nil {
                Image(systemName: "chevron.right")
                    .font(ChatTimelineStyle.small.weight(.semibold))
                    .foregroundStyle(T3Colors.textTertiary)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var accessibilityLabel: String {
        if update.wake == nil { return update.message.text }
        return [update.title, update.statusLabel].compactMap { $0 }.joined(separator: ", ")
    }

    @ViewBuilder
    private var content: some View {
        if update.wake != nil {
            Text(verbatim: update.title)
                .font(ChatTimelineStyle.body)
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(2)
        } else {
            // In full, as on web: the group opened because the reader asked
            // to read these.
            Text(verbatim: update.message.text)
                .font(ChatTimelineStyle.body)
                .foregroundStyle(T3Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func copy() {
        UIPasteboard.general.string = update.message.text
        T3HUD.show("Copied", systemImage: "doc.on.doc")
    }
}

/// "Sent by another agent" over an agent-authored bubble. A link to the
/// sending thread when the server named it, plain text otherwise.
struct AgentSenderByline: View {
    let senderThreadID: String?
    let onOpenThread: ((String) -> Void)?
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// The caption is short and its target is not: at ordinary sizes the
    /// button reaches 44pt into the space around it rather than pushing the
    /// bubble down. At accessibility sizes the text is already that tall.
    private var targetOverhang: CGFloat { dynamicTypeSize.isAccessibilitySize ? 0 : 12 }

    var body: some View {
        if let senderThreadID, let onOpenThread {
            Button { onOpenThread(senderThreadID) } label: {
                HStack(spacing: 3) {
                    Text("Sent by another agent")
                    Image(systemName: "chevron.right")
                        .imageScale(.small)
                        .accessibilityHidden(true)
                }
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .padding(.vertical, targetOverhang)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.vertical, -targetOverhang)
            .accessibilityHint("Opens the thread that sent it.")
        } else {
            Text("Sent by another agent")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textTertiary)
        }
    }
}
