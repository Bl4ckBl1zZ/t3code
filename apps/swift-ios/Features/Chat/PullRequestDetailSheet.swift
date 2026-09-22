import UIKit
import SwiftUI

// Native PR details and reviewed, remote-only GitHub stack actions.
//
// Always pushed: inside Thread Details, the Linked Pull Requests screen, the
// link preview and the workspace's pull request list. Back is the way out.
// Secondary actions live in one toolbar menu; the state's next step is the one
// prominent button under the header.

struct PullRequestDetailSheet: View {
    let access: FeaturePullRequestAccess
    let number: Int

    init(client: any FeatureClient, threadID: String, number: Int) {
        self.access = FeaturePullRequestAccess(client: client, threadID: threadID)
        self.number = number
    }

    init(access: FeaturePullRequestAccess, number: Int) {
        self.access = access
        self.number = number
    }

    @SwiftUI.Environment(\.pullRequestHandoff) private var handoff
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @SwiftUI.Environment(\.openURL) private var openURL
    @State private var handoffSelection: PullRequestHandoffSelection?
    @State private var handoffKind: PullRequestHandoffKind?
    @State private var handoffMode = PullRequestCheckoutMode.worktree
    @State private var handoffPending = false
    @State private var handoffError: String?
    @State private var reviewing = false
    @State private var textEdit: PullRequestTextEdit?
    @State private var selectedAction: NativePullRequestAction?
    @State private var confirmingClose = false
    @State private var actionPending = false
    @State private var failure: ThreadDetailsFailure?
    @State private var hostRefreshRevision = 0
    @State private var refreshingHost = false
    @State private var reviewDraft: PullRequestReviewDraftModel?
    @State private var stack: PullRequestStack?
    @State private var stackError: String?
    @State private var pendingStackAction: NativeStackAction?

    @State private var overview: FeaturePullRequestOverview?
    @State private var loadError: String?
    @State private var loadedAt: Date?
    @State private var tab: PullRequestDetailTab = .summary
    @State private var codeSearch = ""

    var body: some View {
        Group {
            if let overview {
                content(overview)
            } else if let loadError {
                ContentUnavailableView {
                    Label("Couldn’t Load Pull Request", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(loadError)
                } actions: {
                    Button("Try Again") { Task { await load() } }
                        .buttonStyle(.bordered)
                }
            } else {
                loadingPlaceholder
            }
        }
        .environment(\.pullRequestSelectionHandoff, handoff == nil ? nil : PullRequestSelectionHandoff { kind, selection in
            beginHandoff(kind, selection: selection)
        })
        .background(T3Colors.background)
        .pullRequestTitle(number: number)
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
        .toolbar {
            if let overview {
                ToolbarItem(placement: .topBarTrailing) { actionsMenu(overview) }
                if tab == .timeline, canAddComment(overview.detail) {
                    ToolbarItem(placement: .bottomBar) {
                        Button("Comment", systemImage: "text.bubble") { textEdit = .newComment }
                            .labelStyle(.titleAndIcon)
                    }
                }
            }
        }
        .task(id: number) { await load() }
        .sheet(item: $handoffKind) { kind in
            PullRequestHandoffSheet(
                kind: kind,
                subtitle: overview.map { "#\($0.detail.number) · \($0.detail.title)" } ?? "#\(number)",
                selection: handoffSelection,
                offersCheckoutChoice: kind.needsCheckout && access.scope.isProject,
                mode: $handoffMode,
                isPending: handoffPending,
                error: handoffError,
                onCancel: { if !handoffPending { handoffKind = nil } },
                onContinue: performHandoff
            )
        }
        .sheet(item: $pendingStackAction, onDismiss: { Task { await load() } }) { request in
            PullRequestStackActionSheet(request: request, access: access) {
                pendingStackAction = nil
            }
        }
        .sheet(isPresented: $reviewing) {
            if let draft = reviewDraft, let submit = access.submitReview, let detail = overview?.detail {
                PullRequestReviewSheet(draft: draft, verdicts: PullRequestReviewDraftModel.verdicts(capabilities: detail.capabilities, viewer: detail.viewerPermissions), submit: { try await submit(number, detail.url, $0) }) {
                    Task { await load() }
                }
            }
        }
        .sheet(item: $textEdit) { edit in
            textEditor(edit)
        }
        .sheet(item: $selectedAction) { action in
            if let detail = overview?.detail, let run = access.runAction {
                PullRequestActionSheet(action: action, detail: detail, perform: { try await run(detail.number, detail.url, $0) }) {
                    Task { await load(force: action == .approveWorkflows || action == .updateBranch) }
                }
            }
        }
        .alert(
            failure?.title ?? "",
            isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } }),
            presenting: failure
        ) { _ in
            Button("OK") {}
        } message: { failure in
            Text(failure.message)
        }
        .accessibilityIdentifier("pull-request-detail-sheet")
    }

    // MARK: - Loading

    /// The header's shape, drawn static until the real one arrives.
    private var loadingPlaceholder: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Open · #000 · owner/repository").font(T3Typography.supporting)
            Text("A pull request title that wraps").font(T3Typography.threadHeading2)
            Text("feature/branch → main").font(T3Typography.tool)
            Text("+00 −00 · 0 files · by someone").font(T3Typography.supporting)
            Picker("Section", selection: .constant(PullRequestDetailTab.summary)) {
                ForEach(PullRequestDetailTab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.top, 8)
        }
        .foregroundStyle(T3Colors.textSecondary)
        .redacted(reason: .placeholder)
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading pull request")
    }

    /// Content stays on screen through every reload; only the first load has
    /// nothing to show.
    private func load(force: Bool = false) async {
        loadError = nil
        do {
            if force { try await access.invalidate?(number) }
            let result = try await access.overview(number)
            guard !Task.isCancelled else { return }
            let draftKey = "\(access.draftKey):\(result.detail.url)"
            if reviewDraft?.key != "swift-ios.pullRequests.reviewDraft.\(draftKey)" {
                reviewDraft = PullRequestReviewDraftModel(key: draftKey)
            }
            if tab == .code, result.detail.capabilities?.diff != true { tab = .summary }
            overview = result
            loadedAt = .now
            if force { hostRefreshRevision += 1 }
            await loadStack()
        } catch {
            guard !Task.isCancelled else { return }
            loadError = error.localizedDescription
        }
    }

    private func loadStack() async {
        do {
            let loadedStack = try await access.stack(number)
            guard !Task.isCancelled else { return }
            stack = loadedStack
            stackError = nil
        } catch {
            guard !Task.isCancelled else { return }
            stackError = error.localizedDescription
        }
    }

    private func refreshFromHost() async {
        guard !refreshingHost, !actionPending else { return }
        refreshingHost = true
        defer { refreshingHost = false }
        await load(force: true)
    }

    // MARK: - Actions

    private func canAddComment(_ detail: PullRequestDetail) -> Bool {
        access.editing != nil && detail.capabilities?.comment == true && detail.viewerPermissions?.comment == true
    }

    private func canReview(_ detail: PullRequestDetail) -> Bool {
        access.submitReview != nil && reviewDraft != nil
            && !PullRequestReviewDraftModel.verdicts(capabilities: detail.capabilities, viewer: detail.viewerPermissions).isEmpty
    }

    private func primaryAction(_ detail: PullRequestDetail) -> PullRequestPrimaryAction? {
        let primary = PullRequestActionLogic.primary(detail, canResolveInAgent: handoff != nil)
        if case .action = primary, access.runAction == nil { return nil }
        return primary
    }

    /// Everything secondary, grouped: hand it to an agent, take it elsewhere,
    /// edit it, change its state. Destructive state changes come last.
    private func actionsMenu(_ overview: FeaturePullRequestOverview) -> some View {
        let detail = overview.detail
        let primary = primaryAction(detail)
        let stateActions = access.runAction == nil ? [] : PullRequestActionLogic.menuActions(detail, primary: primary)
        return Menu {
            if handoff != nil {
                Menu("Open in Agent", systemImage: "text.bubble") {
                    ForEach(PullRequestHandoffKind.allCases) { kind in
                        if kind != .conflicts || detail.mergeability == .conflicting {
                            Button(kind.label, systemImage: kind.systemImage) { beginHandoff(kind, selection: nil) }
                        }
                    }
                }
            }
            Section {
                if let command = PullRequestCheckoutCommand.build(provider: detail.provider, number: detail.number,
                    headBranch: detail.headBranch, headRepository: detail.headRepositoryNameWithOwner) {
                    Button("Copy Checkout Command", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = command
                        T3HUD.show("Copied", systemImage: "doc.on.doc")
                    }
                }
                if let url = URL(string: detail.url) {
                    Button("Open in Browser", systemImage: "safari") { openURL(url) }
                }
            }
            if access.editing != nil, PullRequestEditingLogic.canEditChangeRequest(detail) {
                Section {
                    Button("Edit Title…", systemImage: "pencil") { textEdit = .title(detail.title) }
                    Button("Edit Description…", systemImage: "text.alignleft") { textEdit = .description(detail.body) }
                }
            }
            if !stateActions.isEmpty {
                Section {
                    ForEach(stateActions) { action in
                        Button(action.label, systemImage: action.systemImage, role: action == .close ? .destructive : nil) {
                            trigger(action, detail: detail)
                        }
                    }
                }
            }
        } label: {
            Label("More", systemImage: "ellipsis")
        }
        .disabled(actionPending)
        .confirmationDialog("Close #\(detail.number)?", isPresented: $confirmingClose, titleVisibility: .visible) {
            Button("Close Pull Request", role: .destructive) {
                Task { await perform(.close, detail: detail) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(NativePullRequestAction.close.explanation)
        }
    }

    private func trigger(_ action: NativePullRequestAction, detail: PullRequestDetail) {
        guard access.runAction != nil else { return }
        if action == .close { confirmingClose = true }
        else if action.needsReview { selectedAction = action }
        else { Task { await perform(action, detail: detail) } }
    }

    private func perform(_ action: NativePullRequestAction, detail: PullRequestDetail) async {
        guard !actionPending, let run = access.runAction else { return }
        actionPending = true
        defer { actionPending = false }
        do {
            try await run(detail.number, detail.url, .init(action: action.rawValue, mergeMethod: nil, updateMethod: nil))
            PlatformHapticEngine.shared.play(.success)
            await load()
        } catch {
            failure = ThreadDetailsFailure(title: action.failureTitle, message: error.localizedDescription)
            PlatformHapticEngine.shared.play(.error)
        }
    }

    private func beginHandoff(_ kind: PullRequestHandoffKind, selection: PullRequestHandoffSelection?) {
        guard handoff != nil, overview != nil else { return }
        handoffMode = .worktree; handoffError = nil; handoffSelection = selection; handoffKind = kind
    }

    private func performHandoff() {
        guard let overview, let handoff, let kind = handoffKind, !handoffPending else { return }
        handoffPending = true; handoffError = nil
        Task {
            defer { handoffPending = false }
            do {
                try await handoff.perform(access.scope, overview, kind, handoffMode, handoffSelection)
                handoffKind = nil
                dismiss()
            } catch {
                handoffError = error.localizedDescription
                PlatformHapticEngine.shared.play(.error)
            }
        }
    }

    @ViewBuilder
    private func textEditor(_ edit: PullRequestTextEdit) -> some View {
        if let detail = overview?.detail, let editing = access.editing?(number, detail.url) {
            let followUp = PullRequestActionLogic.offered(detail).first { $0 == .close || $0 == .reopen }
            PullRequestTextEditor(edit: edit, access: editing, number: detail.number, commentAction: access.runAction == nil ? nil : followUp, performCommentAction: {
                guard let followUp, let run = access.runAction else { return }
                try await run(detail.number, detail.url, PullRequestActionRequest(action: followUp.rawValue, mergeMethod: nil, updateMethod: nil))
            }) { await load() }
        }
    }

    // MARK: - Content

    private func content(_ overview: FeaturePullRequestOverview) -> some View {
        let detail = overview.detail
        let showsCode = detail.capabilities?.diff == true && access.diff != nil
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 20, pinnedViews: .sectionHeaders) {
                header(detail)
                    .padding(.horizontal, 16)

                Section {
                    Group {
                        switch tab {
                        case .summary:
                            summary(detail, activity: overview.activity)
                        case .timeline:
                            timeline(overview.activity, detail: detail)
                        case .code:
                            if showsCode, let diff = access.diff {
                                PullRequestCodeView(number: number, updatedAt: detail.updatedAt, refreshRevision: hostRefreshRevision,
                                    commits: overview.activity?.commits ?? [], search: codeSearch, load: diff,
                                    fileContents: access.fileContents.map { read in { input in try await read(number, detail.url, input) } },
                                    reviewDraft: reviewDraft,
                                    conversations: conversationContext(detail, activity: overview.activity),
                                    canComment: access.submitReview != nil && detail.capabilities?.review?.inlineComment == true && detail.viewerPermissions?.comment == true && !PullRequestReviewDraftModel.verdicts(capabilities: detail.capabilities, viewer: detail.viewerPermissions).isEmpty)
                                    .id(number)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                } header: {
                    Picker("Section", selection: $tab) {
                        ForEach(PullRequestDetailTab.allCases, id: \.self) { tab in
                            if tab != .code || showsCode {
                                Text(tab.rawValue).tag(tab)
                            }
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(T3Colors.background)
                }
            }
            .padding(.top, 8)
            .padding(.bottom, 36)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await refreshFromHost() }
        .modifier(PullRequestCodeSearch(isActive: tab == .code, text: $codeSearch))
    }

    private func header(_ detail: PullRequestDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                PullRequestStateBadge(state: detail.state, isDraft: detail.isDraft)
                Text(PullRequestDetailSections.repositoryLine(detail))
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                    .lineLimit(1)
                if let autoMerge = PullRequestDetailSections.autoMergeLabel(detail) {
                    Text(autoMerge)
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.accent)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(T3Colors.accent.opacity(0.14), in: Capsule())
                        .lineLimit(1)
                }
            }

            Text(detail.title)
                .font(T3Typography.threadHeading2)
                .foregroundStyle(T3Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            Text(PullRequestDetailSections.branchLine(detail))
                .font(T3Typography.tool)
                .foregroundStyle(T3Colors.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)

            Text(PullRequestDetailSections.headerMeta(detail))
                .font(T3Typography.supporting)
                .monospacedDigit()
                .foregroundStyle(T3Colors.textSecondary)

            banners(detail)
            actionRow(detail)
        }
    }

    @ViewBuilder
    private func banners(_ detail: PullRequestDetail) -> some View {
        if let loadError {
            bannerCard(.error) {
                ThreadSheetBanner(tone: .error, title: "Couldn’t Refresh", message: loadError) {
                    Button("Try Again") { Task { await load() } }
                }
            }
        }
        if detail.state == .open, detail.mergeability == .conflicting {
            bannerCard(.error) {
                ThreadSheetBanner(
                    tone: .error,
                    title: "Conflicts with \(detail.baseBranch)",
                    message: "Merging is blocked until they’re resolved."
                )
            }
        } else if let behind = PullRequestDetailSections.behindLabel(detail) {
            bannerCard(.warning) {
                if access.runAction != nil, PullRequestActionLogic.offered(detail).contains(.updateBranch) {
                    ThreadSheetBanner(tone: .warning, title: behind) {
                        Button("Update Branch…") { selectedAction = .updateBranch }
                    }
                } else {
                    ThreadSheetBanner(tone: .warning, title: behind)
                }
            }
        }
        if let waiting = detail.workflowApprovalsRequired, waiting > 0 {
            let title = "\(waiting) \(waiting == 1 ? "workflow" : "workflows") waiting for approval"
            bannerCard(.warning) {
                if access.runAction != nil, PullRequestActionLogic.offered(detail).contains(.approveWorkflows) {
                    ThreadSheetBanner(tone: .warning, title: title) {
                        Button("Approve…") { selectedAction = .approveWorkflows }
                    }
                } else {
                    ThreadSheetBanner(tone: .warning, title: title)
                }
            }
        }
    }

    private func bannerCard(_ tone: ThreadSheetBannerTone, @ViewBuilder content: () -> some View) -> some View {
        content()
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tone.fill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    /// The one prominent verb, and Review beside it.
    @ViewBuilder
    private func actionRow(_ detail: PullRequestDetail) -> some View {
        let primary = primaryAction(detail)
        let showsReview = canReview(detail)
        if primary != nil || showsReview {
            HStack(spacing: 10) {
                if let primary {
                    Button {
                        switch primary {
                        case .resolveConflicts: beginHandoff(.conflicts, selection: nil)
                        case let .action(action): trigger(action, detail: detail)
                        }
                    } label: {
                        Group {
                            if actionPending {
                                ProgressView()
                            } else {
                                switch primary {
                                case .resolveConflicts: Label("Resolve in Agent", systemImage: "text.bubble")
                                case let .action(action): Label(action.primaryLabel, systemImage: action.systemImage)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .t3ProminentButtonStyle()
                    .controlSize(.large)
                    .disabled(actionPending)
                }
                if showsReview {
                    Button {
                        reviewing = true
                    } label: {
                        HStack(spacing: 6) {
                            Text("Review")
                            if let count = reviewDraft?.comments.count, count > 0 {
                                Text("\(count)")
                                    .monospacedDigit()
                                    .font(T3Typography.supportingStrong)
                                    .padding(.horizontal, 6)
                                    .background(T3Colors.subtleStrong, in: Capsule())
                            }
                        }
                        .frame(maxWidth: primary == nil ? .infinity : nil)
                    }
                    .t3SecondaryButtonStyle()
                    .controlSize(.large)
                    .accessibilityLabel(Text("Review, ^[\(reviewDraft?.comments.count ?? 0) pending comment](inflect: true)"))
                }
            }
            .padding(.top, 4)
        }
    }

    // MARK: - Summary

    @ViewBuilder
    private func summary(_ detail: PullRequestDetail, activity: PullRequestActivity?) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            ThreadSheetCard {
                Group {
                    if detail.body.isEmpty {
                        Text("No Description")
                            .font(T3Typography.threadBody)
                            .foregroundStyle(T3Colors.textTertiary)
                    } else {
                        MarkdownMessageView(detail.body)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let activity { reactionBar(activity.reactions ?? [], subjectID: nil, detail: detail) }

            if let stack { stackSection(stack, detail: detail) }
            else if let stackError {
                ThreadSheetCard(title: "Stack") {
                    ThreadSheetCardRow(showsDivider: false) {
                        HStack {
                            Label("Couldn’t load the stack: \(stackError)", systemImage: "exclamationmark.circle")
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.danger)
                            Spacer(minLength: 8)
                            Button("Retry") { Task { await loadStack() } }
                                .buttonStyle(.bordered)
                                .tint(T3Colors.textPrimary)
                        }
                    }
                }
            }

            if !detail.checks.isEmpty { checksSection(detail) }
            reviewersSection(detail, activity: activity)
            labelsSection(detail)
        }
    }

    private func reactionContext(_ detail: PullRequestDetail) -> PullRequestReactionContext {
        PullRequestReactionContext(canReact: detail.capabilities?.reactions == true,
            set: access.react.map { react in { request in try await react(detail.number, detail.url, request) } },
            refresh: { await load() })
    }

    @ViewBuilder private func reactionBar(_ reactions: [PullRequestReaction], subjectID: String?, detail: PullRequestDetail) -> some View {
        if detail.capabilities?.reactions == true || !reactions.isEmpty {
            PullRequestReactionBar(reactions: reactions, subjectID: subjectID, context: reactionContext(detail))
        }
    }

    private func stackSection(_ stack: PullRequestStack, detail: PullRequestDetail) -> some View {
        ThreadSheetCard(title: "Stack") {
            ForEach(Array(stack.layers.enumerated()), id: \.element.id) { index, layer in
                ThreadSheetCardRow(showsDivider: index > 0, dividerInset: 48) {
                    if layer.number == number {
                        stackLayerLabel(layer, isCurrent: true)
                    } else {
                        // Another layer is its own pull request: it pushes,
                        // and back returns here.
                        NavigationLink {
                            PullRequestDetailSheet(access: access, number: layer.number)
                        } label: {
                            HStack {
                                stackLayerLabel(layer, isCurrent: false)
                                ThreadSheetDisclosure()
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            if detail.state == .open, let capabilities = detail.capabilities, let viewer = detail.viewerPermissions {
                if capabilities.actions.contains("merge"), viewer.actions.contains("merge"), !PullRequestActionLogic.mergeMethods(detail).isEmpty {
                    ThreadSheetCardRow(dividerInset: 48) {
                        Button {
                            pendingStackAction = NativeStackAction(stack: stack, number: number, action: "merge", mergeMethods: PullRequestActionLogic.mergeMethods(detail))
                        } label: {
                            Label("Merge Through #\(number)…", systemImage: "arrow.triangle.merge")
                                .foregroundStyle(T3Colors.accent)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                    }
                }
                if stack.layers.last?.number == number,
                   capabilities.actions.contains("update-branch"), viewer.stackRebase == true,
                   capabilities.updateMethods?.contains("rebase") == true {
                    ThreadSheetCardRow(dividerInset: 48) {
                        Button {
                            pendingStackAction = NativeStackAction(stack: stack, number: number, action: "update-branch", mergeMethods: [])
                        } label: {
                            Label("Rebase Stack…", systemImage: "arrow.triangle.branch")
                                .foregroundStyle(T3Colors.accent)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        } footer: {
            Text("Layers run from base to top. Actions update GitHub without changing your checkout.")
        }
    }

    private func stackLayerLabel(_ layer: PullRequestStack.Layer, isCurrent: Bool) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text("#\(layer.number) \(layer.title ?? layer.headBranch)")
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(2)
                Text(PullRequestDetailSections.stateLabel(state: layer.state, isDraft: layer.isDraft ?? false))
                    .font(T3Typography.supporting)
                    .foregroundStyle(PullRequestDetailSections.stateTone(state: layer.state, isDraft: layer.isDraft ?? false).color)
            }
        } icon: {
            Image(symbol: isCurrent ? "checkmark.circle.fill" : T3Symbol.pullRequest)
                .foregroundStyle(isCurrent ? T3Colors.accent : T3Colors.textSecondary)
        }
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
    }

    // MARK: - Checks

    private func checksSection(_ detail: PullRequestDetail) -> some View {
        let summary = PullRequestDetailSections.checksSummary(detail.checks)
        return ThreadSheetCard(title: "Checks") {
            if summary.isAllPassing {
                ThreadSheetCardRow(showsDivider: false) {
                    DisclosureGroup {
                        ForEach(summary.settled) { entry in checkRow(entry.check) }
                    } label: {
                        checksSummaryLabel(summary)
                    }
                    .tint(T3Colors.textTertiary)
                }
            } else {
                ThreadSheetCardRow(showsDivider: false) { checksSummaryLabel(summary) }
                ForEach(summary.attention + summary.running) { entry in
                    ThreadSheetCardRow(dividerInset: 44) { checkRow(entry.check) }
                }
                if !summary.settled.isEmpty {
                    ThreadSheetCardRow(dividerInset: 44) {
                        DisclosureGroup {
                            ForEach(summary.settled) { entry in checkRow(entry.check) }
                        } label: {
                            Label("\(summary.settled.count) Passed", systemImage: "checkmark.circle.fill")
                                .font(T3Typography.threadBody)
                                .foregroundStyle(T3Colors.textPrimary)
                        }
                        .tint(T3Colors.textTertiary)
                    }
                }
            }
        } footer: {
            if let loadedAt {
                Text("Updated \(loadedAt, format: .relative(presentation: .named)). Pull to refresh.")
            }
        }
    }

    /// Counts, worst first, over a static bar sized by how many are in each state.
    private func checksSummaryLabel(_ summary: PullRequestChecksSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: summary.isAllPassing ? "checkmark.circle.fill" : summary.attention.isEmpty ? "clock" : "xmark.circle.fill")
                    .foregroundStyle((summary.isAllPassing ? PullRequestStatusTone.success : summary.attention.isEmpty ? .warning : .danger).color)
                Text(summary.headline)
                    .font(T3Typography.threadBody.weight(.semibold))
                    .foregroundStyle(T3Colors.textPrimary)
                Spacer(minLength: 8)
                Text("\(summary.total)")
                    .font(T3Typography.supporting)
                    .monospacedDigit()
                    .foregroundStyle(T3Colors.textTertiary)
            }
            if !summary.isAllPassing {
                GeometryReader { proxy in
                    let segments = summary.segments
                    let gaps = CGFloat(max(0, segments.count - 1)) * 2
                    HStack(spacing: 2) {
                        ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                            Capsule()
                                .fill(segment.tone.color)
                                .frame(width: max(4, (proxy.size.width - gaps) * CGFloat(segment.count) / CGFloat(max(1, summary.total))))
                        }
                    }
                }
                .frame(height: 6)
                .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// Tapping opens the run's log; long-press hands the check to an agent.
    @ViewBuilder
    private func checkRow(_ check: PullRequestCheck) -> some View {
        let label = HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: PullRequestDetailSections.checkSymbol(check.status))
                .foregroundStyle(PullRequestDetailSections.checkTone(check.status).color)
            VStack(alignment: .leading, spacing: 2) {
                Text(check.name)
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textPrimary)
                if let description = check.description, !description.isEmpty {
                    Text(description)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            if check.url != nil {
                Image(systemName: "arrow.up.right")
                    .imageScale(.small)
                    .foregroundStyle(T3Colors.textTertiary)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .contentShape(Rectangle())
        Group {
            if let address = check.url, let url = URL(string: address) {
                Button { openURL(url) } label: { label }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens the run log")
            } else {
                label
            }
        }
        .contextMenu { PullRequestSelectionMenuItems(selection: .check(check)) }
    }

    // MARK: - Reviewers and labels

    @ViewBuilder
    private func reviewersSection(_ detail: PullRequestDetail, activity: PullRequestActivity?) -> some View {
        // Verdicts need the conversation, so they can only be shown where the
        // activity read landed. Without it the reviewers still list, as bare
        // names, because "requested" would be a claim this cannot make when
        // the verdicts simply were not read.
        let rows = activity.map {
            PullRequestDetailSections.reviewerRows(
                reviewers: $0.reviewers ?? detail.reviewers,
                outcomes: PullRequestDetailSections.latestReviewOutcomes(comments: $0.comments, commits: $0.commits)
            )
        } ?? detail.reviewers.map { PullRequestReviewerRow(id: $0.login, login: $0.login, entry: nil) }
        let avatars = Dictionary((activity?.reviewers ?? detail.reviewers).map { ($0.login, $0.avatarUrl) }, uniquingKeysWith: { first, _ in first })
        let canRequest = detail.capabilities?.reviewers?.request == true && access.reviewers != nil
        if !rows.isEmpty || canRequest {
            ThreadSheetCard(title: "Reviewers") {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    ThreadSheetCardRow(showsDivider: index > 0, dividerInset: 56) {
                        HStack(spacing: 12) {
                            PullRequestAvatar(login: row.login, avatarURL: row.entry?.actor?.avatarUrl ?? avatars[row.login].flatMap { $0 })
                            Text(row.login)
                                .font(T3Typography.threadBody)
                                .foregroundStyle(T3Colors.textPrimary)
                                .lineLimit(1)
                            Spacer(minLength: 8)
                            if let entry = row.entry {
                                Label(entry.label, systemImage: entry.outcome.symbol)
                                    .font(T3Typography.supporting)
                                    .foregroundStyle(entry.isStale ? T3Colors.textTertiary : entry.outcome.tone.color)
                            } else if activity != nil {
                                Text("Requested")
                                    .font(T3Typography.supporting)
                                    .foregroundStyle(T3Colors.textTertiary)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                if canRequest, detail.capabilities?.reviewers?.listCandidates == true,
                   let reviewers = access.reviewers?(number, detail.url) {
                    ThreadSheetCardRow(showsDivider: !rows.isEmpty, dividerInset: 56) {
                        NavigationLink {
                            PullRequestReviewerPicker(
                                access: reviewers,
                                allowed: detail.viewerPermissions?.requestReviewers == true
                            ) { await load() }
                        } label: {
                            HStack {
                                Label("Request Reviewers…", systemImage: "person.badge.plus")
                                    .foregroundStyle(T3Colors.accent)
                                Spacer(minLength: 8)
                                ThreadSheetDisclosure()
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(detail.viewerPermissions?.requestReviewers != true)
                    }
                }
            } footer: {
                if canRequest {
                    if detail.capabilities?.reviewers?.listCandidates != true {
                        Text("Manage reviewers on the host; it does not provide a candidate list.")
                    } else if detail.viewerPermissions?.requestReviewers != true {
                        Text("Requesting reviewers needs write access on this repository.")
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func labelsSection(_ detail: PullRequestDetail) -> some View {
        let canChange = detail.capabilities?.labels == true
        if !detail.labels.isEmpty || canChange {
            ThreadSheetCard(title: "Labels") {
                ThreadSheetCardRow(showsDivider: false) {
                    if detail.labels.isEmpty {
                        Text("None")
                            .font(T3Typography.threadBody)
                            .foregroundStyle(T3Colors.textTertiary)
                    } else {
                        PullRequestChipFlow {
                            ForEach(detail.labels, id: \.name) { PullRequestLabelChip(label: $0) }
                        }
                    }
                }
                if canChange {
                    ThreadSheetCardRow {
                        NavigationLink {
                            PullRequestLabelPickerSheet(access: access, number: number) { await load() }
                        } label: {
                            HStack {
                                Label("Change Labels…", systemImage: "tag")
                                    .foregroundStyle(T3Colors.accent)
                                Spacer(minLength: 8)
                                ThreadSheetDisclosure()
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(detail.viewerPermissions?.labels != true)
                    }
                }
            } footer: {
                if canChange, detail.viewerPermissions?.labels != true {
                    Text("Changing labels needs triage access on this repository.")
                }
            }
        }
    }

    // MARK: - Timeline

    private func conversationContext(_ detail: PullRequestDetail, activity: PullRequestActivity?) -> PullRequestConversationContext {
        PullRequestConversationContext(threads: activity?.reviewThreads ?? [],
            access: access.threads?(number, detail.url),
            canReply: detail.capabilities?.review?.reply == true && detail.viewerPermissions?.comment == true,
            canResolve: detail.capabilities?.review?.resolve == true && detail.viewerPermissions?.resolve == true,
            editing: access.editing?(number, detail.url),
            reactions: reactionContext(detail),
            canEditComment: { PullRequestEditingLogic.canEditComment(detail: detail, author: $0.author, kind: "review-comment") },
            refresh: { await load() })
    }

    @ViewBuilder
    private func timeline(_ activity: PullRequestActivity?, detail: PullRequestDetail) -> some View {
        if let activity {
            let entries = PullRequestDetailSections.timeline(activity)
            VStack(alignment: .leading, spacing: 20) {
                if entries.isEmpty {
                    ContentUnavailableView("No Activity Yet", systemImage: "bubble.left.and.bubble.right")
                } else {
                    ThreadSheetCard {
                        ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                            ThreadSheetCardRow(showsDivider: index > 0, dividerInset: 56) {
                                timelineRow(entry, detail: detail)
                            }
                        }
                    } footer: {
                        if let note = PullRequestDetailSections.truncationNote(activity) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(note)
                                if let url = URL(string: detail.url) {
                                    Button("Open in Browser") { openURL(url) }
                                        .font(T3Typography.supporting)
                                }
                            }
                        }
                    }
                }
                if !activity.reviewThreads.isEmpty {
                    let context = conversationContext(detail, activity: activity)
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Conversations")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                            .padding(.horizontal, 16)
                            .accessibilityAddTraits(.isHeader)
                        ForEach(activity.reviewThreads) { thread in
                            PullRequestThreadCard(thread: thread,
                                access: context.access,
                                canReply: context.canReply,
                                canResolve: context.canResolve,
                                editing: context.editing,
                                reactions: context.reactions,
                                canEditComment: context.canEditComment,
                                onReplied: context.refresh)
                        }
                    }
                }
            }
        } else {
            // The activity read failed while the detail did not; the summary
            // still stands, so this tab explains itself rather than sinking
            // the sheet.
            ContentUnavailableView {
                Label("Conversation Unavailable", systemImage: "exclamationmark.bubble")
            } description: {
                Text("The conversation could not be loaded. Open in browser to read it.")
            } actions: {
                if let url = URL(string: detail.url) {
                    Button("Open in Browser") { openURL(url) }
                        .buttonStyle(.bordered)
                }
            }
        }
    }

    @ViewBuilder
    private func timelineRow(_ entry: PullRequestTimelineEntry, detail: PullRequestDetail) -> some View {
        switch entry.kind {
        case let .commit(commit):
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Image(systemName: "smallcircle.filled.circle")
                    .foregroundStyle(T3Colors.textTertiary)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(commit.messageHeadline)
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(2)
                    Text([PullRequestDetailSections.shortOid(commit.oid), PullRequestDetailSections.relativeLabel(commit.committedDate)]
                        .compactMap { $0 }.joined(separator: " · "))
                        .font(T3Typography.tool)
                        .foregroundStyle(T3Colors.textTertiary)
                }
            }
            .accessibilityElement(children: .combine)
        case let .comment(comment):
            HStack(alignment: .top, spacing: 12) {
                PullRequestAvatar(login: comment.author?.login ?? "?", avatarURL: comment.author?.avatarUrl)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Text(PullRequestDetailSections.commentAuthorLabel(comment))
                            .font(T3Typography.supportingStrong)
                            .foregroundStyle(T3Colors.textPrimary)
                        if let outcome = PullRequestDetailSections.reviewOutcome(comment) {
                            // Not dimmed for staleness here: the row sits in the
                            // chronology, so the commits that superseded it are
                            // already visible underneath.
                            Label(outcome.label, systemImage: outcome.symbol)
                                .font(T3Typography.supporting)
                                .foregroundStyle(outcome.tone.color)
                        } else if let state = PullRequestDetailSections.reviewStateLabel(comment) {
                            Text(state)
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.textTertiary)
                        }
                        Spacer(minLength: 0)
                        if let relative = PullRequestDetailSections.relativeLabel(comment.createdAt) {
                            Text(relative)
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.textTertiary)
                        }
                    }
                    if !comment.body.isEmpty {
                        MarkdownMessageView(comment.body)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    reactionBar(comment.reactions ?? [], subjectID: comment.id, detail: detail)
                }
            }
            .contentShape(Rectangle())
            .contextMenu {
                PullRequestSelectionMenuItems(selection: .comment(comment))
                if access.editing != nil,
                   PullRequestEditingLogic.canEditComment(detail: detail, author: comment.author, kind: comment.kind.rawValue) {
                    Button("Edit", systemImage: "pencil") {
                        textEdit = .comment(id: comment.id, kind: comment.kind.rawValue, body: comment.body)
                    }
                }
            }
        }
    }
}

private extension FeaturePullRequestScope {
    var isProject: Bool {
        if case .project = self { return true }
        return false
    }
}

private extension View {
    /// "#412" with "Pull Request" beneath on iOS 26; the number alone was
    /// ambiguous before subtitles existed, so earlier systems say both.
    @ViewBuilder
    func pullRequestTitle(number: Int) -> some View {
        if #available(iOS 26, *) {
            navigationTitle("#\(number)").navigationSubtitle("Pull Request")
        } else {
            navigationTitle("Pull Request #\(number)")
        }
    }
}

/// `.searchable` only while the Code tab is showing; the other tabs have
/// nothing to filter.
private struct PullRequestCodeSearch: ViewModifier {
    let isActive: Bool
    @Binding var text: String

    func body(content: Content) -> some View {
        if isActive {
            content.t3Searchable(text: $text, placement: .navigationBarDrawer(displayMode: .always), prompt: Text("Filter Changed Files"))
        } else {
            content
        }
    }
}

/// Stages a pull request for an agent: what it will be asked, where the code
/// is checked out, and any selection the task quotes.
private struct PullRequestHandoffSheet: View {
    let kind: PullRequestHandoffKind
    let subtitle: String
    let selection: PullRequestHandoffSelection?
    let offersCheckoutChoice: Bool
    @Binding var mode: PullRequestCheckoutMode
    let isPending: Bool
    let error: String?
    let onCancel: () -> Void
    let onContinue: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label(kind.label, systemImage: kind.systemImage)
                        .foregroundStyle(T3Colors.textPrimary)
                    if offersCheckoutChoice {
                        Picker("Checkout", selection: $mode) {
                            Text("Separate Worktree").tag(PullRequestCheckoutMode.worktree)
                            Text("Local Repository").tag(PullRequestCheckoutMode.local)
                        }
                        .pickerStyle(.menu)
                        .disabled(isPending)
                    }
                } header: {
                    Text(subtitle).lineLimit(2)
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        if offersCheckoutChoice {
                            Text(mode == .local
                                ? "This switches the branch in the project repository, affecting other threads using it."
                                : "Prepares or reuses a worktree for this pull request.")
                                .foregroundStyle(mode == .local ? T3Colors.warning : T3Colors.textSecondary)
                        }
                        Text("The task is staged in the composer for you to review and send.")
                    }
                }
                .t3GroupedRow()

                if let selection {
                    Section(selection.kind.title) {
                        Text(selection.context)
                            .font(T3Typography.tool)
                            .lineLimit(12)
                            .textSelection(.enabled)
                    }
                    .t3GroupedRow()
                }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.circle")
                            .foregroundStyle(T3Colors.danger)
                    }
                    .t3GroupedRow()
                }
            }
            .t3GroupedListBackground()
            .navigationTitle("Open in Agent")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(title: "Continue", isEnabled: !isPending, isBusy: isPending, action: onContinue),
                onDismiss: onCancel
            )
            .interactiveDismissDisabled(isPending)
        }
        .presentationDetents([.medium, .large])
        .t3GlassSheetBackground()
    }
}
