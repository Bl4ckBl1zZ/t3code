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
        NavigationStack {
            List {
                if isWorking {
                    Section {
                        // Parity with desktop: restoring under a running turn
                        // races the agent's writes, so the turn goes first.
                        ThreadSheetBanner(
                            tone: .warning,
                            title: "The agent is still working",
                            message: "Stop the current turn before restoring."
                        )
                        .listRowBackground(ThreadSheetBannerTone.warning.fill)
                    }
                } else if case let .failed(message) = phase {
                    Section {
                        ThreadSheetBanner(tone: .error, title: "Couldn’t restore", message: message)
                            .listRowBackground(ThreadSheetBannerTone.error.fill)
                    }
                }
                facts
            }
            .t3SheetList()
            .navigationTitle(request.capturedAtLabel.map { "Restore to \($0)?" } ?? "Restore?")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .toolbar { closeItem }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                footer
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .t3GlassSheetBackground()
        .interactiveDismissDisabled(phase == .running)
        .onChange(of: phase) { _, phase in
            if case .failed = phase { PlatformHapticEngine.shared.play(.error) }
        }
        .accessibilityIdentifier("checkpoint-restore-sheet")
    }

    /// Always present, and visibly disabled while the restore runs, so the
    /// lock on swiping away is not a mystery.
    @ToolbarContentBuilder
    private var closeItem: some ToolbarContent {
        if #available(iOS 26, *) {
            ToolbarItem(placement: .cancellationAction) {
                Button(role: .close) { dismiss() }
                    .disabled(phase == .running)
            }
        } else {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
                    .disabled(phase == .running)
            }
        }
    }

    private var facts: some View {
        Section {
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
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textTertiary)
                    }
                }
                .padding(.leading, 30)
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
        } footer: {
            Text("This can’t be undone.")
        }
        .t3GroupedRow()
    }

    private func factRow(
        systemImage: String,
        tint: Color,
        @ViewBuilder content: () -> some View
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: systemImage)
                .foregroundStyle(tint)
                .frame(width: 20)
                .accessibilityHidden(true)
            content()
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textPrimary)
        }
    }

    private func fileRow(_ file: OrchestrationV2CheckpointFileSummary) -> some View {
        HStack(spacing: 8) {
            Text(file.path)
                .font(T3Typography.tool)
                .foregroundStyle(T3Colors.textSecondary)
                .lineLimit(1)
                .truncationMode(.head)
            Spacer(minLength: 6)
            if file.additions > 0 {
                Text("+\(file.additions)")
                    .font(T3Typography.tool)
                    .foregroundStyle(T3Colors.diffAddition)
            }
            if file.deletions > 0 {
                Text("−\(file.deletions)")
                    .font(T3Typography.tool)
                    .foregroundStyle(T3Colors.diffDeletion)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// The sheet is itself the confirmation, so its one button commits. While
    /// the agent works, that button is the interrupt instead.
    @ViewBuilder
    private var footer: some View {
        if isWorking {
            Button(action: onInterrupt) {
                Label("Interrupt Turn", systemImage: "stop.fill")
                    .frame(maxWidth: .infinity)
            }
            .t3ProminentButtonStyle()
            .controlSize(.large)
        } else {
            Button(action: restore) {
                Group {
                    if phase == .running {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Restoring Files…")
                        }
                    } else if case .failed = phase {
                        Label("Try Again", systemImage: "arrow.counterclockwise")
                    } else {
                        Text("Restore to This Point")
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .checkpointRestoreButtonStyle()
            .controlSize(.large)
            .disabled(phase == .running)
            .accessibilityIdentifier("checkpoint-restore-confirm")
        }
    }

    private func restore() {
        guard phase != .running else { return }
        phase = .running
        Task { @MainActor in
            do {
                try await onRestore()
                T3HUD.show(
                    request.capturedAtLabel.map { "Restored to \($0)" } ?? "Restored",
                    systemImage: "arrow.counterclockwise"
                )
                dismiss()
            } catch {
                phase = .failed(error.localizedDescription)
            }
        }
    }
}

private extension View {
    /// A system red prominent button. The palette's danger color is a light
    /// pink in dark palettes, and white text on it is unreadable; the system
    /// red keeps contrast in both appearances.
    @ViewBuilder
    func checkpointRestoreButtonStyle() -> some View {
        if #available(iOS 26, *) {
            buttonStyle(.glassProminent).tint(.red)
        } else {
            buttonStyle(.borderedProminent).tint(.red)
        }
    }
}
