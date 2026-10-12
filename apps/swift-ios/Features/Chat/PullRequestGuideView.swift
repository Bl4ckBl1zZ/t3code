import SwiftUI

// The Guide tab of a pull request: a tour of stops through the change, written
// by an agent on the server. The tab shows the notice (write, writing, failed,
// stale) and the outline; each stop pushes a reader that steps through the
// tour with its prose, code excerpts and notes.

/// What a stop needs to cut excerpts from the diff and open a file in full.
@MainActor
struct PullRequestGuideCodeContext {
    /// Reads a page of the pull request's diff: cursor, then commit.
    let load: (String?, String?) async throws -> PullRequestDiffResult
    let reviewDraft: PullRequestReviewDraftModel?
    let canComment: Bool
    let conversations: PullRequestConversationContext
    let fileContents: ((PullRequestDiffFileInput) async throws -> PullRequestDiffFileContents)?
}

struct PullRequestGuideView: View {
    let model: PullRequestReviewGuideModel
    /// Links `#123` and commit references in the guide's prose.
    let pullRequestURL: String
    /// Nil where the host serves no diff; stops then show prose and notes only.
    let code: PullRequestGuideCodeContext?
    /// Opens the review form from the tour's last stop, when the reader may review.
    let finishReview: (() -> Void)?

    var body: some View {
        let notice = model.notice
        VStack(alignment: .leading, spacing: 20) {
            if notice.kind != .ready {
                PullRequestGuideNoticeCard(model: model, notice: notice, compact: model.data?.guide != nil)
            }
            if let guide = model.data?.guide {
                outline(guide)
            }
        }
        // Read each time the tab shows, so a guide written elsewhere appears.
        .task { await model.refresh() }
        .task(id: model.running) { await model.pollWhileRunning() }
    }

    private func outline(_ guide: PullRequestReviewGuide) -> some View {
        let files = PullRequestReviewGuideTour.fileCount(guide)
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(guide.stops.count) \(guide.stops.count == 1 ? "stop" : "stops")")
                    .font(T3Typography.threadBody.weight(.semibold))
                    .foregroundStyle(T3Colors.textPrimary)
                Text("through \(files) \(files == 1 ? "file" : "files")")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            .monospacedDigit()

            ThreadSheetCard {
                ForEach(Array(guide.stops.enumerated()), id: \.offset) { position, stop in
                    ThreadSheetCardRow(showsDivider: position > 0, dividerInset: 56) {
                        NavigationLink {
                            PullRequestGuideStopView(model: model, pullRequestURL: pullRequestURL, code: code, start: position, finishReview: finishReview)
                        } label: {
                            stopRow(stop, position: position)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if !guide.stops.isEmpty {
                NavigationLink {
                    PullRequestGuideStopView(model: model, pullRequestURL: pullRequestURL, code: code, start: 0, finishReview: finishReview)
                } label: {
                    Label("Start Tour", systemImage: "arrow.right")
                        .frame(maxWidth: .infinity)
                }
                .t3ProminentButtonStyle()
                .controlSize(.large)
            }
        }
    }

    private func stopRow(_ stop: PullRequestReviewGuideStop, position: Int) -> some View {
        HStack(spacing: 12) {
            Text("\(position + 1)")
                .font(T3Typography.supportingStrong)
                .monospacedDigit()
                .foregroundStyle(T3Colors.textPrimary)
                .frame(width: 28, height: 28)
                .background(T3Colors.subtle, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(stop.title)
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textPrimary)
                    .multilineTextAlignment(.leading)
                HStack(spacing: 4) {
                    if stop.attention != nil {
                        Image(systemName: "eye")
                            .foregroundStyle(T3Colors.warning)
                            .accessibilityLabel("Look closely")
                    }
                    Text(PullRequestReviewGuideTour.subline(stop))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textTertiary)
            }
            Spacer(minLength: 8)
            ThreadSheetDisclosure()
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Stop \(position + 1): \(stop.title)")
    }
}

/// Write, writing, failed and stale, with the action kept in one place as the
/// state changes.
struct PullRequestGuideNoticeCard: View {
    let model: PullRequestReviewGuideModel
    let notice: PullRequestReviewGuideNotice
    /// A guide is already on screen, so the notice is a strip above it rather
    /// than the whole tab.
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label {
                Text(compact ? notice.title : "Review Guide")
                    .font(T3Typography.threadBody.weight(.semibold))
                    .foregroundStyle(T3Colors.textPrimary)
            } icon: {
                Image(systemName: notice.isFailure ? "exclamationmark.circle" : notice.isBusy ? "clock" : "list.number")
                    .foregroundStyle(notice.isFailure ? T3Colors.danger : T3Colors.textSecondary)
            }
            Text(notice.description)
                .font(T3Typography.supporting)
                .foregroundStyle(notice.isFailure ? T3Colors.danger : T3Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            HStack(spacing: 12) {
                Button {
                    Task {
                        if notice.kind == .unavailable { await model.refresh() } else { await model.write() }
                    }
                } label: {
                    HStack(spacing: 8) {
                        if notice.isBusy { ProgressView() }
                        Text(notice.action)
                    }
                    .frame(maxWidth: compact ? nil : .infinity)
                }
                .modifier(PullRequestGuideActionStyle(prominent: !compact))
                .disabled(notice.isBusy)
                if notice.kind == .writing, case let .running(_, startedAt) = model.data?.run,
                   let date = PullRequestDetailSections.parseDate(startedAt) {
                    Text("Started \(date, format: .dateTime.hour().minute())")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}

private struct PullRequestGuideActionStyle: ViewModifier {
    let prominent: Bool
    func body(content: Content) -> some View {
        if prominent {
            content.t3ProminentButtonStyle().controlSize(.large)
        } else {
            content.t3SecondaryButtonStyle()
        }
    }
}

/// One stop of the tour, stepped in place: Next at the end of the stop, and
/// the arrows in the toolbar for either direction.
struct PullRequestGuideStopView: View {
    let model: PullRequestReviewGuideModel
    let pullRequestURL: String
    let code: PullRequestGuideCodeContext?
    let finishReview: (() -> Void)?
    @State private var position: Int
    @State private var excerptWidth: CGFloat = 0
    @SwiftUI.Environment(\.dismiss) private var dismiss

    init(model: PullRequestReviewGuideModel, pullRequestURL: String, code: PullRequestGuideCodeContext?, start: Int,
         finishReview: (() -> Void)?) {
        self.model = model
        self.pullRequestURL = pullRequestURL
        self.code = code
        self.finishReview = finishReview
        _position = State(initialValue: start)
    }

    private var guide: PullRequestReviewGuide? { model.data?.guide }
    private var stopCount: Int { guide?.stops.count ?? 0 }
    private var clamped: Int { PullRequestReviewGuideTour.step(position, by: 0, stopCount: max(stopCount, 1)) }
    private var stop: PullRequestReviewGuideStop? {
        guard let guide, guide.stops.indices.contains(clamped) else { return nil }
        return guide.stops[clamped]
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Color.clear.frame(height: 0).id("top")
                    if let stop {
                        content(stop)
                    } else {
                        ContentUnavailableView("Stop Unavailable", systemImage: "list.number",
                            description: Text(model.error ?? "This guide was rewritten. Go back to start the new tour."))
                    }
                }
                .padding(16)
                .padding(.bottom, 24)
                .frame(maxWidth: T3Metrics.readingWidth)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: clamped) { _, _ in proxy.scrollTo("top", anchor: .top) }
        }
        .background(T3Colors.background)
        .navigationTitle(stopCount > 0 ? "Stop \(clamped + 1) of \(stopCount)" : "Stop")
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("Previous Stop", systemImage: "chevron.up") { position = clamped - 1 }
                    .disabled(clamped == 0)
                Button("Next Stop", systemImage: "chevron.down") { position = clamped + 1 }
                    .disabled(clamped >= stopCount - 1)
            }
        }
        .task(id: "\(clamped):\(guide?.headSha ?? "")") {
            guard let stop, let code, !model.state.stale else { return }
            await model.loadFiles(PullRequestReviewGuideTour.filePaths(stop), load: code.load)
        }
        .task(id: model.running) { await model.pollWhileRunning() }
    }

    @ViewBuilder
    private func content(_ stop: PullRequestReviewGuideStop) -> some View {
        let notice = model.notice
        let stale = model.state.stale
        if notice.kind != .ready {
            PullRequestGuideNoticeCard(model: model, notice: notice, compact: true)
        }
        Text(stop.title)
            .font(T3Typography.threadHeading2)
            .foregroundStyle(T3Colors.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
        if !stop.summary.isEmpty {
            PullRequestMarkdownView(stop.summary, pullRequestURL: pullRequestURL)
        }
        if let attention = stop.attention {
            VStack(alignment: .leading, spacing: 8) {
                Label(PullRequestReviewGuideTour.attentionLabel(attention.kind), systemImage: "eye")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.warning)
                PullRequestMarkdownView(attention.note, pullRequestURL: pullRequestURL)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(T3Colors.warning.opacity(0.10), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        if stale {
            Text("Excerpts are hidden until the guide is rewritten for the current head.")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textTertiary)
        } else {
            ForEach(Array(stop.excerpts.enumerated()), id: \.offset) { _, excerpt in
                excerptView(excerpt, stop: stop)
            }
            if let error = model.diff.error {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.danger)
            }
        }
        notes(stop)
        files(stop, stale: stale)
        if !stop.questions.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Questions to Consider")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textSecondary)
                    .accessibilityAddTraits(.isHeader)
                ForEach(Array(stop.questions.enumerated()), id: \.offset) { _, question in
                    PullRequestMarkdownView(question, pullRequestURL: pullRequestURL)
                }
            }
        }
        nextCard
    }

    // MARK: - Excerpts

    @ViewBuilder
    private func excerptView(_ excerpt: PullRequestReviewGuideExcerpt, stop: PullRequestReviewGuideStop) -> some View {
        let file = model.file(excerpt.path)
        let lines = file.map { PullRequestReviewGuideTour.excerptLines($0.lines, excerpt: excerpt) } ?? []
        let markers = PullRequestReviewGuideTour.markers(stop, excerpt: excerpt)
        let focus = PullRequestReviewGuideFocus(excerpt)
        VStack(alignment: .leading, spacing: 8) {
            if !excerpt.caption.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                PullRequestMarkdownView(excerpt.caption, pullRequestURL: pullRequestURL)
            }
            VStack(alignment: .leading, spacing: 0) {
                excerptHeader(excerpt, file: file)
                Rectangle().fill(T3Colors.separator).frame(height: 0.5)
                if lines.isEmpty {
                    Text(excerptPlaceholder(excerpt))
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                        .padding(12)
                } else {
                    ScrollView(.horizontal) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(lines) { line in
                                HStack(spacing: 0) {
                                    if !markers.isEmpty {
                                        Text(focus.lineNumber(line).flatMap { markers[$0] }?.joined() ?? "")
                                            .font(T3Typography.supportingStrong)
                                            .foregroundStyle(T3Colors.accent)
                                            .frame(width: 22)
                                    }
                                    FeatureDiffLineRow(line: line, isSelected: false,
                                        minimumWidth: max(0, excerptWidth - (markers.isEmpty ? 0 : 22)),
                                        numberWidth: 40, showsBothNumbers: false, allowsTextSelection: false)
                                }
                            }
                        }
                    }
                    .scrollIndicators(.hidden)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { excerptWidth = $0 }
            .background(T3Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(T3Colors.border, lineWidth: 0.5))
        }
    }

    @ViewBuilder
    private func excerptHeader(_ excerpt: PullRequestReviewGuideExcerpt, file: FeatureReviewFile?) -> some View {
        let label = HStack(spacing: 8) {
            Text(excerpt.path)
                .font(T3Typography.tool)
                .foregroundStyle(T3Colors.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 4)
            Text("\(excerpt.start)–\(excerpt.end)")
                .font(T3Typography.supporting)
                .monospacedDigit()
                .foregroundStyle(T3Colors.textTertiary)
            if file != nil, code != nil {
                Image(systemName: "arrow.up.right")
                    .imageScale(.small)
                    .foregroundStyle(T3Colors.textTertiary)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .contentShape(Rectangle())
        if let file, let code {
            NavigationLink {
                fileView(file, code: code, focus: PullRequestReviewGuideFocus(excerpt))
            } label: { label }
                .buttonStyle(.plain)
                .accessibilityLabel("Open \(excerpt.path) at line \(excerpt.start) in the full diff")
        } else {
            label
        }
    }

    private func excerptPlaceholder(_ excerpt: PullRequestReviewGuideExcerpt) -> String {
        if code == nil { return "This host does not serve the diff, so the excerpt can’t be shown." }
        let missing = model.file(excerpt.path) == nil
        if model.diff.loading || (missing && model.diff.nextCursor != nil && model.diff.error == nil) {
            return "Loading \(excerpt.path)…"
        }
        return "\(excerpt.path):\(excerpt.start)–\(excerpt.end) is not in the loaded diff."
    }

    private func fileView(_ file: FeatureReviewFile, code: PullRequestGuideCodeContext,
                          focus: PullRequestReviewGuideFocus?) -> PullRequestCodeFileView {
        PullRequestCodeFileView(file: file, reviewDraft: code.reviewDraft, canComment: code.canComment,
            conversations: code.conversations, commit: nil, fileContents: code.fileContents, focus: focus)
    }

    // MARK: - Notes, files and next

    @ViewBuilder
    private func notes(_ stop: PullRequestReviewGuideStop) -> some View {
        let notes = PullRequestReviewGuideTour.letteredNotes(stop)
        if !notes.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                Text("Notes on This Stop")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textSecondary)
                    .accessibilityAddTraits(.isHeader)
                ForEach(notes, id: \.marker) { entry in
                    HStack(alignment: .top, spacing: 10) {
                        Text(entry.marker)
                            .font(T3Typography.supportingStrong)
                            .foregroundStyle(T3Colors.accent)
                            .frame(width: 26, height: 26)
                            .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                        VStack(alignment: .leading, spacing: 4) {
                            Text(entry.note.title)
                                .font(T3Typography.threadBody.weight(.semibold))
                                .foregroundStyle(T3Colors.textPrimary)
                            Text("\(entry.note.path.split(separator: "/").last.map(String.init) ?? entry.note.path):\(entry.note.line)")
                                .font(T3Typography.tool)
                                .foregroundStyle(T3Colors.textTertiary)
                            if !entry.note.body.isEmpty {
                                PullRequestMarkdownView(entry.note.body, pullRequestURL: pullRequestURL)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func files(_ stop: PullRequestReviewGuideStop, stale: Bool) -> some View {
        if !stop.files.isEmpty {
            ThreadSheetCard(title: "Also in This Stop") {
                ForEach(Array(stop.files.enumerated()), id: \.offset) { index, entry in
                    ThreadSheetCardRow(showsDivider: index > 0) {
                        let label = HStack(spacing: 8) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.path)
                                    .font(T3Typography.tool)
                                    .foregroundStyle(T3Colors.textPrimary)
                                    .lineLimit(2)
                                    .truncationMode(.middle)
                                if let note = entry.note, !note.isEmpty {
                                    Text(note)
                                        .font(T3Typography.supporting)
                                        .foregroundStyle(T3Colors.textSecondary)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        if !stale, let code, let file = model.file(entry.path) {
                            NavigationLink { fileView(file, code: code, focus: nil) } label: {
                                HStack { label; ThreadSheetDisclosure() }
                            }
                            .buttonStyle(.plain)
                        } else {
                            label
                        }
                    }
                }
            }
        }
    }

    private var nextCard: some View {
        let hasNext = clamped < stopCount - 1
        let canFinishReview = !hasNext && finishReview != nil && !model.state.stale
        return Button {
            if hasNext {
                position = clamped + 1
            } else {
                dismiss()
                if canFinishReview { finishReview?() }
            }
        } label: {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(hasNext ? "Next · \(clamped + 2) of \(stopCount)" : "End of guide")
                        .font(T3Typography.supporting)
                        .monospacedDigit()
                        .foregroundStyle(T3Colors.textTertiary)
                    Text(hasNext ? guide?.stops[clamped + 1].title ?? "" : canFinishReview ? "Finish Review" : "Finish Tour")
                        .font(T3Typography.threadBody.weight(.semibold))
                        .foregroundStyle(T3Colors.textPrimary)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 8)
                Image(systemName: hasNext ? "arrow.right" : "checkmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(T3Colors.primaryActionForeground)
                    .frame(width: 40, height: 40)
                    .background(T3Colors.primaryAction, in: Circle())
            }
            .padding(.top, 16)
            .overlay(alignment: .top) { Rectangle().fill(T3Colors.separator).frame(height: 0.5) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
