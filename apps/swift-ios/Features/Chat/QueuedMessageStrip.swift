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

struct QueuedMessageStripView: View {
    let queuedRuns: [QueuedThreadRun]
    let canReorder: Bool
    /// The run currently dispatching, whose row locks and loses its editor.
    let dispatchingRunID: String?
    let busyRunID: String?
    let onReorder: (QueueReorderTarget) -> Void
    let onEdit: (_ runID: String, _ text: String) -> Void
    let onDelete: (_ runID: String) -> Void

    @State private var editingRunID: String?
    @State private var editText = ""

    var body: some View {
        if !queuedRuns.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text(headerText)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                    .padding(.horizontal, 4)

                ForEach(Array(queuedRuns.enumerated()), id: \.element.id) { index, queued in
                    row(queued, at: index)
                }
            }
            .padding(.bottom, 8)
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
        "\(queuedRuns.count) queued — sends when the agent finishes"
    }

    @ViewBuilder
    private func row(_ queued: QueuedThreadRun, at index: Int) -> some View {
        let isDispatching = dispatchingRunID == queued.run.id
        HStack(spacing: 8) {
            leadingIndicator(isDispatching: isDispatching)

            if editingRunID == queued.run.id {
                TextField("Queued message", text: $editText, axis: .vertical)
                    .font(T3Typography.supporting)
                    .lineLimit(1...5)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .background(T3Colors.input, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .accessibilityLabel("Edit queued message")

                iconButton("checkmark", label: "Save queued message") {
                    saveEdit(queued)
                }
                iconButton("xmark", label: "Cancel editing") {
                    cancelEdit()
                }
            } else {
                Text(QueuedMessagePresentation.preview(queued))
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textPrimary.opacity(0.85))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 0) {
                    moveButton(at: index, direction: .up, isDispatching: isDispatching)
                    moveButton(at: index, direction: .down, isDispatching: isDispatching)
                    iconButton(
                        "pencil",
                        label: "Edit queued message",
                        disabled: isDispatching || busyRunID != nil
                    ) {
                        beginEdit(queued)
                    }
                    iconButton(
                        "trash",
                        label: "Delete queued message",
                        disabled: isDispatching || busyRunID != nil,
                        danger: true
                    ) {
                        onDelete(queued.run.id)
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .background(T3Colors.subtle, in: rowShape)
        .overlay { rowShape.stroke(T3Colors.border, lineWidth: 1) }
    }

    private var rowShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
    }

    @ViewBuilder
    private func leadingIndicator(isDispatching: Bool) -> some View {
        Group {
            if isDispatching {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Sending queued message")
            } else {
                Image(systemName: "clock")
                    .font(.system(size: 11))
                    .foregroundStyle(T3Colors.textTertiary)
            }
        }
        .frame(width: 20, height: 20)
    }

    private func moveButton(
        at index: Int,
        direction: QueueMoveDirection,
        isDispatching: Bool
    ) -> some View {
        let target = ThreadWorkflows.reorderTarget(
            queuedRuns: queuedRuns, index: index, direction: direction
        )
        return iconButton(
            direction == .up ? "chevron.up" : "chevron.down",
            label: direction == .up ? "Move queued message up" : "Move queued message down",
            disabled: isDispatching || busyRunID != nil || !canReorder || target == nil
        ) {
            guard let target else { return }
            onReorder(target)
        }
    }

    private func iconButton(
        _ symbol: String,
        label: String,
        disabled: Bool = false,
        danger: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(danger ? T3Colors.danger : T3Colors.textTertiary)
                .frame(width: 30, height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.3 : 1)
        .accessibilityLabel(label)
    }

    private func beginEdit(_ queued: QueuedThreadRun) {
        editText = queued.text
        editingRunID = queued.run.id
    }

    private func cancelEdit() {
        editingRunID = nil
        editText = ""
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
