import SwiftUI

// The restore-point preview: instead of firing the rollback on a bare tap (or
// hiding it behind a text confirm), the sheet shows what restoring will
// actually do — which files return to their earlier state, how much of the
// conversation is deleted, which newer restore points die — and only then
// offers the destructive confirm. Progress and failure live in the same sheet,
// so a failed restore is never silent.

/// Everything the sheet needs, computed from the transcript at request time.
struct CheckpointRestoreRequest: Identifiable, Equatable {
    let target: ThreadActivityRollbackTarget
    let files: [OrchestrationV2CheckpointFileSummary]
    /// User messages after the restore point — the "exchanges" that vanish.
    let exchangesAfter: Int
    /// Ready checkpoints in the same scope that a restore invalidates.
    let newerRestorePoints: Int
    let capturedAtLabel: String?

    var id: String { target.checkpointID }

    /// Derives the preview facts from the projected timeline.
    static func make(
        target: ThreadActivityRollbackTarget,
        timelineItems: [OrchestrationV2ProjectedTurnItem]
    ) -> CheckpointRestoreRequest {
        var files: [OrchestrationV2CheckpointFileSummary] = []
        var capturedAtLabel: String?
        var exchangesAfter = 0
        var newerRestorePoints = 0
        var foundIndex: Int?

        for (index, projected) in timelineItems.enumerated() {
            switch projected.item.payload {
            case let .checkpoint(checkpointID, scopeID, itemFiles):
                if checkpointID == target.checkpointID {
                    foundIndex = index
                    files = itemFiles
                    if let captured = ThreadTimelineDay.date(
                        fromISO8601: projected.item.base.completedAt
                            ?? projected.item.base.updatedAt
                    ) {
                        capturedAtLabel = captured.formatted(
                            date: .omitted,
                            time: .shortened
                        )
                    }
                } else if let foundIndex, index > foundIndex, scopeID == target.scopeID {
                    newerRestorePoints += 1
                }
            case .userMessage:
                if let foundIndex, index > foundIndex {
                    exchangesAfter += 1
                }
            default:
                break
            }
        }

        return CheckpointRestoreRequest(
            target: target,
            files: files,
            exchangesAfter: exchangesAfter,
            newerRestorePoints: newerRestorePoints,
            capturedAtLabel: capturedAtLabel
        )
    }
}

struct CheckpointRestoreSheet: View {
    let request: CheckpointRestoreRequest
    /// A running turn blocks the restore; the sheet offers the interrupt.
    let isWorking: Bool
    let onInterrupt: () -> Void
    /// Throws on failure; the sheet owns progress and the retryable error.
    let onRestore: () async throws -> Void

    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var phase: Phase = .idle

    private enum Phase: Equatable {
        case idle
        case running
        case failed(String)
    }

    private static let visibleFileLimit = 6

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.bottom, 14)

            facts

            if case let .failed(message) = phase {
                failureNotice(message)
                    .padding(.top, 12)
            }

            Spacer(minLength: 16)

            footer
        }
        .padding(.horizontal, 20)
        .padding(.top, 22)
        .padding(.bottom, 12)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(phase == .running)
        .accessibilityIdentifier("checkpoint-restore-sheet")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(
                request.capturedAtLabel.map { "Restore to \($0)?" }
                    ?? "Restore to this point?"
            )
            .font(T3Typography.threadHeading3)
            .foregroundStyle(T3Colors.textPrimary)
            Text("This cannot be undone.")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textTertiary)
        }
    }

    private var facts: some View {
        VStack(alignment: .leading, spacing: 12) {
            factRow(systemImage: "folder", tint: T3Colors.textSecondary) {
                if request.files.isEmpty {
                    Text("Workspace files return to their state at this point")
                } else {
                    Text("**\(request.files.count) file\(request.files.count == 1 ? "" : "s")** return\(request.files.count == 1 ? "s" : "") to their earlier state")
                }
            }

            if !request.files.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(request.files.prefix(Self.visibleFileLimit), id: \.path) { file in
                        fileRow(file)
                    }
                    if request.files.count > Self.visibleFileLimit {
                        Text("…and \(request.files.count - Self.visibleFileLimit) more")
                            .font(ChatTimelineStyle.small)
                            .foregroundStyle(T3Colors.textTertiary)
                            .padding(.leading, 30)
                    }
                }
            }

            factRow(systemImage: "bubble.left.and.bubble.right", tint: T3Colors.textSecondary) {
                if request.exchangesAfter == 0 {
                    Text("No messages after this point are deleted")
                } else {
                    Text("**\(request.exchangesAfter) exchange\(request.exchangesAfter == 1 ? "" : "s")** after this point \(request.exchangesAfter == 1 ? "is" : "are") deleted")
                }
            }

            if request.newerRestorePoints > 0 {
                factRow(systemImage: "hourglass", tint: T3Colors.warning) {
                    Text("\(request.newerRestorePoints) newer restore point\(request.newerRestorePoints == 1 ? " becomes" : "s become") unusable")
                        .foregroundStyle(T3Colors.warning)
                }
            }
        }
    }

    private func factRow(
        systemImage: String,
        tint: Color,
        @ViewBuilder content: () -> some View
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(tint)
                .frame(width: 20)
            content()
                .font(T3Typography.control)
                .foregroundStyle(T3Colors.textPrimary)
        }
    }

    private func fileRow(_ file: OrchestrationV2CheckpointFileSummary) -> some View {
        HStack(spacing: 8) {
            Text(file.path)
                .font(ChatTimelineStyle.smallMono)
                .foregroundStyle(T3Colors.textSecondary)
                .lineLimit(1)
                .truncationMode(.head)
            Spacer(minLength: 6)
            if file.additions > 0 {
                Text("+\(file.additions)")
                    .font(ChatTimelineStyle.smallMono)
                    .foregroundStyle(T3Colors.success)
            }
            if file.deletions > 0 {
                Text("−\(file.deletions)")
                    .font(ChatTimelineStyle.smallMono)
                    .foregroundStyle(T3Colors.danger)
            }
        }
        .padding(.leading, 30)
    }

    private func failureNotice(_ message: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 13, weight: .semibold))
            Text(message)
                .font(T3Typography.supporting)
        }
        .foregroundStyle(T3Colors.danger)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(T3Colors.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private var footer: some View {
        if isWorking {
            // Parity with desktop: restoring under a running turn races the
            // agent's writes, so the turn goes first.
            VStack(spacing: 8) {
                Text("The agent is still working. Interrupt the current turn before restoring.")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    onInterrupt()
                } label: {
                    Text("Interrupt turn")
                        .font(T3Typography.control)
                        .foregroundStyle(T3Colors.textPrimary)
                        .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget)
                        .overlay {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(T3Colors.inputBorder, lineWidth: 1)
                        }
                }
                .buttonStyle(.plain)
            }
        } else {
            VStack(spacing: 8) {
                Button {
                    restore()
                } label: {
                    HStack(spacing: 8) {
                        if phase == .running {
                            ProgressView()
                                .controlSize(.small)
                                .tint(.white)
                            Text("Restoring files…")
                        } else if case .failed = phase {
                            Image(systemName: "arrow.counterclockwise")
                                .font(.system(size: 13, weight: .semibold))
                            Text("Try again")
                        } else {
                            Text("Restore to this point")
                        }
                    }
                    .font(T3Typography.control.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget)
                    .background(
                        T3Colors.danger,
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                    )
                }
                .buttonStyle(.plain)
                .disabled(phase == .running)
                .opacity(phase == .running ? 0.75 : 1)
                .accessibilityIdentifier("checkpoint-restore-confirm")

                Button("Cancel") { dismiss() }
                    .font(T3Typography.control)
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .disabled(phase == .running)
            }
        }
    }

    private func restore() {
        guard phase != .running else { return }
        phase = .running
        Task { @MainActor in
            do {
                try await onRestore()
                dismiss()
            } catch {
                phase = .failed(error.localizedDescription)
            }
        }
    }
}
