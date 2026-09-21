import SwiftUI

// Queued messages waiting for the running turn to finish, rendered above the
// composer. Rows send top-to-bottom and stay editable, deletable and
// reorderable until the moment they dispatch.
//
// Ports apps/mobile/src/features/threads/QueuedMessageStrip.tsx, retargeted from
// that client's device-local outbox onto server queue state: a message sent with
// dispatchMode "queue" becomes a run in `queued` status, so the strip's rows are
// `QueuedThreadRun`s and its three actions are the server commands
// `queued-run.reorder`, `queued-run.edit` and `queued-run.cancel`.
//
// This is deliberately not `FeatureOutboxStore`. The outbox holds submissions
// that never reached a server — an offline compose, or a send interrupted
// mid-flight — and it retries them. A queued run is already committed server
// side and every client can see it. A message appears in exactly one of the two.

/// What saving an edited queued message should do.
public enum QueuedMessageEditOutcome: Equatable, Sendable {
    /// Emptying a text-only message means deleting it.
    case delete
    case save(String)
}

public enum QueuedMessagePresentation {
    /// Collapse a queued message to a single presentable line.
    public static func preview(text: String, attachmentCount: Int) -> String {
        let firstLine =
            text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        if let firstLine, !firstLine.isEmpty { return firstLine }
        if attachmentCount > 0 {
            return attachmentCount == 1 ? "1 image" : "\(attachmentCount) images"
        }
        return "Queued message"
    }

    public static func preview(_ queued: QueuedThreadRun) -> String {
        preview(text: queued.text, attachmentCount: queued.attachmentCount)
    }

    /// With attachments the images still make a sendable payload, so an emptied
    /// text field is a text edit rather than a delete.
    public static func editOutcome(text: String, attachmentCount: Int) -> QueuedMessageEditOutcome {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty, attachmentCount == 0 { return .delete }
        return .save(text)
    }

    /// Pre-measure estimate of the strip's height so the transcript's initial
    /// bottom inset accounts for it before the real overlay height is measured —
    /// otherwise content sits under the strip and jumps once measurement lands.
    /// Header line (~16) + per-row height with gaps (~42) + bottom padding (8).
    public static func estimatedHeight(messageCount: Int) -> CGFloat {
        messageCount == 0 ? 0 : 16 + CGFloat(messageCount) * 42 + 8
    }
}

// MARK: - View

/// The queue as one glass card above the composer. Each row is a preview with
/// an "…" menu (long-press opens the same actions): steer, edit, move and
/// delete. Glass rather than a 4% wash, because the transcript scrolls under
/// the card and the two texts would otherwise print over each other.
struct QueuedMessageStripView: View {
    let queuedRuns: [QueuedThreadRun]
    /// Restart recovery is holding the queue; nothing sends until resumed.
    let isHeld: Bool
    let canReorder: Bool
    /// The run currently dispatching, whose row locks and loses its editor.
    let dispatchingRunID: String?
    let busyRunID: String?
    /// Set when the provider can fold a queued message into the running turn.
    /// Absent, the action hides rather than showing a disabled control on every
    /// row of a queue that can never be steered.
    let steerTargetRunID: String?
    let onReorder: (QueueReorderTarget) -> Void
    let onEdit: (_ runID: String, _ text: String) -> Void
    let onDelete: (_ runID: String) -> Void
    let onPromoteToSteer: (_ queuedRunID: String, _ targetRunID: String) -> Void
    let onResumeQueue: () -> Void

    @State private var editingRunID: String?
    @State private var editText = ""
    @FocusState private var editorFocused: Bool

    private let cardShape = RoundedRectangle(cornerRadius: 22, style: .continuous)

    var body: some View {
        if !queuedRuns.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(headerText)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .padding(.horizontal, 14)
                    .padding(.top, 10)
                    .padding(.bottom, 2)

                if isHeld { heldNotice }

                ForEach(Array(queuedRuns.enumerated()), id: \.element.id) { index, queued in
                    row(queued, at: index)
                }
            }
            .padding(.bottom, 6)
            .t3GlassEffect(.regular, in: cardShape)
            .t3GlassRim(in: cardShape)
            .padding(.bottom, 2)
            .animation(.easeInOut(duration: 0.18), value: queuedRuns)
            .accessibilityIdentifier("queued-message-strip")
            .onChange(of: dispatchingRunID) {
                // A row that starts dispatching under an open editor loses the
                // edit session: the payload it was editing is already on its
                // way out.
                if let editingRunID, editingRunID == dispatchingRunID {
                    cancelEdit()
                }
            }
            .onChange(of: queuedRuns.map(\.id)) {
                if let editingRunID, !queuedRuns.contains(where: { $0.id == editingRunID }) {
                    cancelEdit()
                }
            }
        }
    }

    private var headerText: String {
        if isHeld { return "\(queuedRuns.count) queued — paused" }
        return "\(queuedRuns.count) queued — sends when the agent finishes"
    }

    private var heldNotice: some View {
        HStack(spacing: 8) {
            Image(systemName: "pause.circle")
                .foregroundStyle(T3Colors.textSecondary)
                .accessibilityHidden(true)
            Text("Paused when the server restarted. Nothing was lost.")
                .foregroundStyle(T3Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Button("Resume", action: onResumeQueue)
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .tint(T3Colors.textPrimary)
                .frame(minHeight: T3Metrics.minimumTapTarget)
                .accessibilityIdentifier("queued-message-strip-resume")
        }
        .font(T3Typography.supporting)
        .padding(.horizontal, 14)
    }

    @ViewBuilder
    private func row(_ queued: QueuedThreadRun, at index: Int) -> some View {
        let isDispatching = dispatchingRunID == queued.run.id
        let isBusy = busyRunID == queued.run.id
        HStack(spacing: 8) {
            leadingIndicator(isWorking: isDispatching || isBusy, isDispatching: isDispatching)

            if editingRunID == queued.run.id {
                TextField("Queued message", text: $editText, axis: .vertical)
                    .font(T3Typography.supporting)
                    .lineLimit(1...5)
                    .focused($editorFocused)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(T3Colors.input, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .accessibilityLabel("Edit queued message")

                Button {
                    saveEdit(queued)
                } label: {
                    Image(systemName: "checkmark")
                        .font(.footnote.weight(.bold))
                }
                .t3ProminentButtonStyle()
                .buttonBorderShape(.circle)
                .accessibilityLabel("Save queued message")

                Button(action: cancelEdit) {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.bold))
                }
                .t3SecondaryButtonStyle()
                .buttonBorderShape(.circle)
                .accessibilityLabel("Cancel editing")
            } else {
                Text(isDispatching ? "Sending…" : QueuedMessagePresentation.preview(queued))
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Menu {
                    actions(for: queued, at: index, isDispatching: isDispatching)
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.body.weight(.medium))
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                        .contentShape(Rectangle())
                }
                .disabled(isDispatching || busyRunID != nil)
                .accessibilityLabel("Queued message actions")
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 4)
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .contentShape(Rectangle())
        .contextMenu {
            if editingRunID != queued.run.id, !isDispatching, busyRunID == nil {
                actions(for: queued, at: index, isDispatching: isDispatching)
            }
        }
    }

    /// The row's actions, shared by the "…" menu and the long-press menu.
    /// Move items only exist when the provider can reorder at all.
    @ViewBuilder
    private func actions(for queued: QueuedThreadRun, at index: Int, isDispatching: Bool) -> some View {
        if let steerTargetRunID {
            Button("Steer Current Turn", systemImage: "arrow.turn.left.up") {
                onPromoteToSteer(queued.run.id, steerTargetRunID)
            }
        }
        Button("Edit", systemImage: "pencil") { beginEdit(queued) }
        if canReorder {
            moveButton(at: index, direction: .up)
            moveButton(at: index, direction: .down)
        }
        Section {
            Button("Delete", systemImage: "trash", role: .destructive) {
                onDelete(queued.run.id)
            }
        }
    }

    @ViewBuilder
    private func leadingIndicator(isWorking: Bool, isDispatching: Bool) -> some View {
        Group {
            if isWorking {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel(isDispatching ? "Sending queued message" : "Updating queued message")
            } else {
                Image(systemName: "clock")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                    .accessibilityHidden(true)
            }
        }
        .frame(width: 20, height: 20)
    }

    @ViewBuilder
    private func moveButton(at index: Int, direction: QueueMoveDirection) -> some View {
        if let target = ThreadWorkflows.reorderTarget(
            queuedRuns: queuedRuns, index: index, direction: direction
        ) {
            Button(
                direction == .up ? "Move Up" : "Move Down",
                systemImage: direction == .up ? "arrow.up" : "arrow.down"
            ) {
                onReorder(target)
            }
        }
    }

    private func beginEdit(_ queued: QueuedThreadRun) {
        editText = queued.text
        editingRunID = queued.run.id
        editorFocused = true
    }

    private func cancelEdit() {
        editingRunID = nil
        editText = ""
        editorFocused = false
    }

    private func saveEdit(_ queued: QueuedThreadRun) {
        switch QueuedMessagePresentation.editOutcome(
            text: editText, attachmentCount: queued.attachmentCount
        ) {
        case .delete:
            onDelete(queued.run.id)
        case let .save(text):
            onEdit(queued.run.id, text)
        }
        cancelEdit()
    }
}
