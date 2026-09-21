import SwiftUI

// Ported from apps/mobile/src/features/threads/ThreadActivityInspector.tsx. The
// model behind it is already ported in ThreadActivityInspector.swift; this is
// the sheet that renders it.

/// A file link the reader tapped, already resolved to a workspace-relative
/// path. The caller owns the route because only it knows the environment.
public struct ThreadActivityFileOpenRequest: Equatable, Sendable {
    public let relativePath: String
    public let line: Int?
    /// The thread the activity came from, which can be a parent rather than the
    /// thread being read. Carried so the caller builds the route with the real
    /// provenance; `ThreadActivityFileRoute` is what decides to discard it.
    public let sourceThreadID: String?

    public init(relativePath: String, line: Int?, sourceThreadID: String? = nil) {
        self.relativePath = relativePath
        self.line = line
        self.sourceThreadID = sourceThreadID
    }
}

struct ThreadActivityInspectorView: View {
    let model: ThreadActivityInspectorModel
    let currentThreadID: String
    let currentWireThreadID: String
    let activitySourceThreadID: String
    var workspaceRoot: String?
    var onOpenFile: (ThreadActivityFileOpenRequest) -> Void = { _ in }
    var onOpenURL: (URL) -> Void = { _ in }
    var onRollback: (ThreadActivityRollbackTarget) -> Void = { _ in }

    @State private var isRollingBack = false
    @State private var showsDetails = false

    /// Leads with what the tool did; orchestration metadata waits behind the
    /// collapsed "Details" disclosure at the end.
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(model.blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }

            if let ending = model.ending {
                Text(verbatim: ending.label)
                    .font(ChatTimelineStyle.small)
                    .foregroundStyle(endingColor(ending.tone))
                    .padding(.top, -6)
            }

            if let diff = model.diff, !diff.isEmpty {
                section("Patch") {
                    InlineUnifiedDiff(diff: diff, maxHeight: 320)
                }
            }

            if let files = model.checkpointFiles, !files.isEmpty {
                section("Changed Files") {
                    checkpointFileList(files)
                }
            }

            if !model.fileLinks.isEmpty {
                section("Files") {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(model.fileLinks.enumerated()), id: \.offset) { _, link in
                            fileLinkRow(link)
                        }
                    }
                }
            }

            if !model.webLinks.isEmpty {
                section("Sources") {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(model.webLinks, id: \.url) { link in
                            webLinkRow(link)
                        }
                    }
                }
            }

            if let target = model.rollbackTarget {
                rollbackButton(target)
            }

            details
        }
    }

    // MARK: - Blocks

    @ViewBuilder
    private func blockView(_ block: ThreadActivityInspectorBlock) -> some View {
        let text = InspectorBlockText(block: block)

        if let label = block.label {
            section(label) { text }
        } else {
            text
        }
    }

    private func endingColor(_ tone: ThreadActivityInspectorEnding.Tone) -> Color {
        switch tone {
        case .neutral: T3Colors.textTertiary
        case .warning: T3Colors.warning
        case .danger: T3Colors.danger
        }
    }

    // MARK: - Details

    /// Orchestration metadata (item, status, run, node, session, raw JSON).
    /// Useful when debugging, noise when reading, so it starts collapsed.
    private var details: some View {
        VStack(alignment: .leading, spacing: 8) {
            Rectangle()
                .fill(ChatTimelineStyle.hairline)
                .frame(height: 1)

            Button {
                withAnimation(.snappy) { showsDetails.toggle() }
            } label: {
                HStack(spacing: 6) {
                    sectionLabel("Details")
                    Spacer(minLength: 8)
                    TimelineDisclosureChevron(isExpanded: showsDetails)
                }
                .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(showsDetails ? "Expanded" : "Collapsed")

            if showsDetails {
                if !model.fields.isEmpty {
                    fieldsGrid
                }
                ForEach(Array(model.detailBlocks.enumerated()), id: \.offset) { _, block in
                    blockView(block)
                }
                blockView(
                    ThreadActivityInspectorBlock(
                        label: "Raw Item", value: model.structuredDetails, monospaced: true
                    )
                )
            }
        }
    }

    private var fieldsGrid: some View {
        LazyVGrid(
            columns: [
                GridItem(.flexible(), spacing: 16, alignment: .topLeading),
                GridItem(.flexible(), spacing: 16, alignment: .topLeading),
            ],
            alignment: .leading,
            spacing: 8
        ) {
            ForEach(Array(model.fields.enumerated()), id: \.offset) { _, field in
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: field.label)
                        .font(ChatTimelineStyle.small)
                        .foregroundStyle(T3Colors.textTertiary)
                    Text(verbatim: field.value)
                        .font(ChatTimelineStyle.small)
                        .foregroundStyle(T3Colors.textPrimary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    // MARK: - Rows

    private func checkpointFileList(
        _ files: [OrchestrationV2CheckpointFileSummary]
    ) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(files.enumerated()), id: \.offset) { index, file in
                if index > 0 {
                    Rectangle()
                        .fill(ChatTimelineStyle.hairline)
                        .frame(height: 1)
                }
                HStack(spacing: 8) {
                    Text(verbatim: file.path)
                        .font(ChatTimelineStyle.smallMono)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(verbatim: file.kind)
                        .font(ChatTimelineStyle.small)
                        .foregroundStyle(T3Colors.textSecondary)
                    WorkRowDiffStat(additions: file.additions, deletions: file.deletions)
                }
                .padding(.horizontal, 12)
                .frame(minHeight: T3Metrics.minimumTapTarget)
            }
        }
        .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    @ViewBuilder
    private func fileLinkRow(_ link: ThreadActivityFileLink) -> some View {
        // An absolute path outside the workspace has no route to open, so the
        // row still shows the label but stops being a link.
        let relativePath = ThreadWorkspaceFilePath.relative(
            workspaceRoot: workspaceRoot, target: link.path
        ) ?? (link.path.hasPrefix("/") ? nil : link.path)

        Button {
            guard let relativePath else { return }
            onOpenFile(
                ThreadActivityFileOpenRequest(
                    relativePath: relativePath,
                    line: link.line,
                    sourceThreadID: activitySourceThreadID
                )
            )
        } label: {
            linkRowLabel(
                symbol: "doc.text",
                label: link.label,
                opens: relativePath != nil
            )
        }
        .buttonStyle(.plain)
        .disabled(relativePath == nil)
    }

    private func webLinkRow(_ link: ThreadActivityWebLink) -> some View {
        Button {
            guard let url = URL(string: link.url) else { return }
            onOpenURL(url)
        } label: {
            linkRowLabel(symbol: "safari", label: link.label, opens: true)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isLink)
    }

    /// Borderless and a full 44pt tall, with a chevron when it goes somewhere.
    private func linkRowLabel(symbol: String, label: String, opens: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .font(ChatTimelineStyle.small.weight(.medium))
                .foregroundStyle(T3Colors.textTertiary)
                .accessibilityHidden(true)
            Text(verbatim: label)
                .font(ChatTimelineStyle.small)
                .foregroundStyle(opens ? T3Colors.textPrimary : T3Colors.textSecondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if opens {
                Image(systemName: "chevron.right")
                    .font(ChatTimelineStyle.small.weight(.semibold))
                    .foregroundStyle(T3Colors.textTertiary)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .contentShape(Rectangle())
    }

    private func rollbackButton(_ target: ThreadActivityRollbackTarget) -> some View {
        Button {
            // Opens the restore preview sheet — the sheet owns progress and
            // confirmation, so no local busy latch.
            onRollback(target)
        } label: {
            Label("Restore to This Point…", systemImage: "clock.arrow.circlepath")
                .font(ChatTimelineStyle.bodyStrong)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .tint(T3Colors.textPrimary)
        .controlSize(.large)
        .disabled(isRollingBack)
        .accessibilityLabel("Roll back to this checkpoint")
    }

    // MARK: - Chrome

    private func sectionLabel(_ label: String) -> some View {
        Text(verbatim: label)
            .font(ChatTimelineStyle.smallStrong)
            .foregroundStyle(T3Colors.textTertiary)
    }

    private func section(
        _ label: String,
        @ViewBuilder content: () -> some View
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            sectionLabel(label)
            content()
        }
    }
}

/// Inspector output inline in the transcript: a few lines, then "Show More".
/// Never a scroll view of its own, which would trap the transcript's scroll.
private struct InspectorBlockText: View {
    let block: ThreadActivityInspectorBlock
    @State private var isExpanded = false

    private static let collapsedLineLimit = 8

    /// Counted, not measured: newlines or length past what eight lines hold.
    private var isLong: Bool {
        var lines = 1
        for character in block.value where character == "\n" {
            lines += 1
            if lines > Self.collapsedLineLimit { return true }
        }
        return block.value.count > Self.collapsedLineLimit * 60
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: block.value)
                .font(block.monospaced ? ChatTimelineStyle.smallMono : ChatTimelineStyle.small)
                .foregroundStyle(T3Colors.textSecondary)
                .lineLimit(isExpanded ? nil : Self.collapsedLineLimit)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if isLong {
                Button(isExpanded ? "Show Less" : "Show More") {
                    withAnimation(.snappy) { isExpanded.toggle() }
                }
                .font(ChatTimelineStyle.smallStrong)
                .foregroundStyle(T3Colors.accent)
                .buttonStyle(.plain)
                .frame(minHeight: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
            }
        }
    }
}
