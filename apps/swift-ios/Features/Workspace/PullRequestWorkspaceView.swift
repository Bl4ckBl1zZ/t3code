import SwiftUI
import UIKit

struct PullRequestWorkspaceView: View {
    @Bindable var model: FeatureRootModel
    let manager: any FeatureProjectPullRequestManaging
    @SwiftUI.Environment(\.openURL) private var openURL
    @AppStorage("swift-ios.pullRequests.preferences") private var storedPreferences = ""
    @State private var preferences = NativePullRequestPreferences()
    @State private var feed = NativePullRequestWorkspaceModel()
    @State private var showingFilters = false
    @State private var restored = false
    @State private var visibleRowIDs: Set<String> = []

    private var supportedEnvironments: [FeatureEnvironment] { model.snapshot.environments.filter { $0.supportsPullRequests == true } }
    private var requestKey: String {
        preferences.requestKey + "|" + supportedEnvironments.map(\.id).sorted().joined(separator: ",")
            + "|" + model.snapshot.projects.map { "\($0.id):\($0.repositoryCanonicalKey ?? "")" }.sorted().joined(separator: ",")
    }

    @State private var refreshError: String?

    var body: some View {
        NavigationStack {
            content
                .background(T3Colors.background)
                .navigationBarTitleDisplayMode(.inline)
                .pullRequestTitle("Pull Requests", subtitle: preferences.summary(environments: model.snapshot.environments, projects: model.snapshot.projects))
                .t3Searchable(text: $preferences.query, prompt: Text("Search Pull Requests"))
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showingFilters = true } label: {
                            Image(systemName: preferences.hasActiveFilters ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                        }
                        .accessibilityLabel("Filter and sort pull requests")
                        .accessibilityValue(preferences.hasActiveFilters ? "Filtered" : "")
                    }
                }
                .t3SheetToolbar(.close)
                .t3NavigationChrome()
                .navigationDestination(for: PullRequestWorkspaceDestination.self) { destination in
                    PullRequestDetailSheet(
                        access: FeaturePullRequestAccess(manager: manager, scope: destination.scope) { action, phase in
                            feed.noteAction(action, phase: phase, rowID: destination.rowID)
                        },
                        number: destination.number
                    )
                }
                .sheet(isPresented: $showingFilters) {
                    PullRequestWorkspaceFilters(preferences: $preferences, environments: supportedEnvironments,
                        projects: model.snapshot.projects, hosts: feed.hosts)
                }
        }
        .onAppear {
            guard !restored else { return }
            preferences = NativePullRequestPreferences.read(storedPreferences)
            restored = true
        }
        .onChange(of: preferences) { storedPreferences = preferences.serialized }
        .task(id: feed.listingRevision.uuidString + "|" + visibleRowIDs.sorted().joined(separator: ",")) {
            do { try await Task.sleep(for: .milliseconds(120)) } catch { return }
            await feed.loadStats(visibleRowIDs: visibleRowIDs, manager: manager, preferences: preferences)
        }
        .task(id: restored ? requestKey : "unrestored") {
            guard restored else { return }
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            await reload()
        }
    }

    @ViewBuilder private var content: some View {
        if supportedEnvironments.isEmpty {
            ContentUnavailableView {
                Label("Pull Requests Unavailable", symbol: T3Symbol.pullRequest)
            } description: {
                Text("Connect to an environment that supports pull requests.")
            }
        } else if let reason = preferences.unavailableScopeDescription(environments: model.snapshot.environments, projects: model.snapshot.projects) {
            ContentUnavailableView {
                Label("Saved Scope Unavailable", systemImage: "server.rack")
            } description: {
                Text(reason)
            } actions: {
                Button("Show All Projects") { preferences.environmentID = nil; preferences.projectID = nil }
                    .t3SecondaryButtonStyle()
            }
        } else {
            list(rows: feed.rows(preferences: preferences))
        }
    }

    private func list(rows: [NativePullRequestRow]) -> some View {
        let notices = ([refreshError].compactMap { $0 } + feed.messages)
        let groups = preferences.involvement == "all"
            ? [0, 1, 2].map { group in (group, rows.filter { $0.group == group }) }
            : [(-1, rows)]
        return List {
            if !notices.isEmpty {
                Section {
                    ForEach(notices, id: \.self) { message in
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.warning)
                            .listRowBackground(T3Colors.warning.opacity(0.1))
                    }
                }
            }
            if rows.isEmpty {
                Section {
                    if feed.loading {
                        ForEach(Self.placeholderRows.indices, id: \.self) { index in
                            PullRequestWorkspaceRow(row: Self.placeholderRows[index], environmentName: "Environment", project: nil, searchText: "")
                                .redacted(reason: .placeholder)
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel(index == 0 ? "Loading pull requests" : "")
                                .accessibilityHidden(index != 0)
                        }
                        .listRowBackground(Color.clear)
                    } else {
                        emptyState.listRowSeparator(.hidden).listRowBackground(Color.clear)
                    }
                }
            }
            ForEach(groups, id: \.0) { group, entries in
                if !entries.isEmpty {
                    Section {
                        ForEach(entries) { row in
                            link(for: row)
                        }
                    } header: {
                        if group >= 0 { Text(["Authored by You", "Review Requested", "Other Pull Requests"][group]) }
                    }
                }
            }
            if feed.hasMore || !footerNotes.isEmpty {
                Section {
                    if feed.hasMore {
                        pageFooter(loadedCount: rows.count)
                    }
                } footer: {
                    if !footerNotes.isEmpty { Text(footerNotes.joined(separator: "\n\n")) }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await reload(force: true) }
        .toolbar {
            if feed.loading && !rows.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    ProgressView().accessibilityLabel("Loading pull requests")
                }
            }
        }
    }

    private func link(for row: NativePullRequestRow) -> some View {
        NavigationLink(value: PullRequestWorkspaceDestination(
            rowID: row.id,
            scope: .init(projectID: row.projectID, host: row.entry.host, repository: row.entry.repository),
            number: row.entry.number
        )) {
            PullRequestWorkspaceRow(row: row, environmentName: model.snapshot.environments.first { $0.id == row.environmentID }?.name,
                project: model.snapshot.projects.first { $0.id == row.projectID }, searchText: preferences.query)
        }
        .listRowBackground(Color.clear)
        .onAppear { visibleRowIDs.insert(row.id) }
        .onDisappear { visibleRowIDs.remove(row.id) }
        .swipeActions(edge: .trailing) {
            if let url = Self.hostURL(row) {
                Button("Copy Link", systemImage: "link") { copy(url) }.tint(.gray)
                Button("Open on Host", systemImage: "safari") { openURL(url) }.tint(.blue)
            }
        }
        .contextMenu {
            if let url = Self.hostURL(row) {
                Button("Open on Host", systemImage: "arrow.up.right.square") { openURL(url) }
                Button("Copy Link", systemImage: "link") { copy(url) }
            }
        }
    }

    @ViewBuilder private var emptyState: some View {
        if !preferences.query.isEmpty {
            ContentUnavailableView.search(text: preferences.query)
        } else {
            ContentUnavailableView {
                Label("No Matching Pull Requests", symbol: T3Symbol.pullRequest)
            } description: {
                Text("Change the filters or refresh your environments.")
            } actions: {
                Button("Refresh") { Task { await reload(force: true) } }
                    .t3SecondaryButtonStyle()
            }
        }
    }

    /// Pages in as soon as the footer scrolls into view. The identity follows the
    /// loaded row count, so a page that adds rows while the footer is still on
    /// screen asks for the next one, and a page that adds none stops there and
    /// leaves the button.
    private func pageFooter(loadedCount: Int) -> some View {
        ZStack {
            if feed.loading {
                ProgressView().accessibilityLabel("Loading more pull requests")
            } else {
                Button("Load More", action: loadMore)
            }
        }
        .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .id(loadedCount)
        .onAppear(perform: loadMore)
    }

    private var footerNotes: [String] {
        var notes: [String] = []
        if !feed.localSearchHosts.isEmpty && !preferences.query.isEmpty {
            notes.append("\(feed.localSearchHosts.joined(separator: ", ")) searches only the pull requests loaded so far. Load more to search older ones.")
        }
        if feed.reachedHostLimit {
            notes.append("This host can't page beyond the loaded limit. Narrow the search or open the host for older changes.")
        }
        return notes
    }

    private func loadMore() {
        guard !feed.loading else { return }
        Task { await feed.loadMore(manager: manager, preferences: preferences) }
    }

    private func copy(_ url: URL) {
        UIPasteboard.general.string = url.absoluteString
        T3HUD.show("Link Copied", systemImage: "link")
    }

    private static func hostURL(_ row: NativePullRequestRow) -> URL? {
        guard let url = URL(string: row.entry.url), ["https", "http"].contains(url.scheme ?? "") else { return nil }
        return url
    }

    /// Stand-ins drawn redacted while the first page loads.
    private static let placeholderRows: [NativePullRequestRow] = (1...5).map { number in
        NativePullRequestRow(environmentID: "placeholder", entry: PullRequestListEntry(
            provider: "github", host: "github.com", projectId: "placeholder", projectTitle: "Project", repository: "owner/repository",
            number: number, title: number.isMultiple(of: 2) ? "Placeholder pull request title" : "Placeholder pull request title that wraps",
            url: "", author: PullRequestActor(login: "author", name: nil, avatarUrl: nil), headBranch: "", baseBranch: "",
            state: .open, isDraft: false, mergeability: .mergeable, additions: 0, deletions: 0, createdAt: "", updatedAt: "",
            viewerReviewRequested: false, labels: [], reviewDecision: nil, checksState: nil))
    }

    private func reload(force: Bool = false) async {
        if force, let cache = manager as? any FeaturePullRequestCacheInvalidating {
            var failures: [String] = []
            for environment in supportedEnvironments where preferences.environmentID == nil || preferences.environmentID == environment.id {
                do { try await cache.invalidatePullRequestListings(environmentID: environment.id) }
                catch { failures.append("\(environment.name): \(error.localizedDescription)") }
            }
            refreshError = failures.isEmpty ? nil : failures.joined(separator: "\n")
        }
        guard !Task.isCancelled else { return }
        await feed.reload(manager: manager, environments: model.snapshot.environments, projects: model.snapshot.projects, preferences: preferences)
    }
}

/// A row's link target. A value rather than a view, so the detail outlives
/// its row: closing a pull request from an "open" list drops the row at once
/// and must not pop the screen that closed it.
private struct PullRequestWorkspaceDestination: Hashable {
    let rowID: String
    let scope: FeaturePullRequestProjectScope
    let number: Int
}

private struct PullRequestWorkspaceRow: View {
    let row: NativePullRequestRow
    let environmentName: String?
    let project: FeatureProject?
    let searchText: String

    /// The same state glyphs and colors as a Home row's pull request line.
    private var isDraft: Bool { row.entry.state == .open && row.entry.isDraft }
    private var color: Color { isDraft ? T3Colors.textSecondary : FeatureThreadRow.pullRequestColor(row.entry.state.rawValue) }
    private var symbol: String {
        switch row.entry.state {
        case .merged: "arrow.triangle.merge"
        case .closed: "xmark.circle"
        case .open: isDraft ? "pencil.circle" : T3Symbol.pullRequest
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(symbol: symbol)
                .font(.body).foregroundStyle(color).frame(width: 22).padding(.top, 1)
                .accessibilityLabel(isDraft ? "Draft" : row.entry.state.rawValue.capitalized)
            VStack(alignment: .leading, spacing: 6) {
                Text(row.entry.title).font(T3Typography.supportingStrong).foregroundStyle(T3Colors.textPrimary).lineLimit(3)
                HStack(spacing: 5) {
                    if let project {
                        ProjectFaviconBadge(environmentID: project.environmentID, workspaceRoot: project.path,
                            faviconPath: project.faviconPath, projectIcon: project.projectIcon, projectTitle: project.name, size: 12) {
                            Image(systemName: "folder")
                        }
                    }
                    Text("\(row.entry.repository) #\(row.entry.number)").lineLimit(1)
                }.font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                HStack(spacing: 7) {
                    Text(row.entry.author?.login ?? "Unknown author").lineLimit(1)
                    if row.entry.isDraft { Text("Draft") }
                    if row.entry.mergeability == .conflicting { Label("Conflicts", systemImage: "exclamationmark.triangle").foregroundStyle(T3Colors.warning) }
                    else if let state = row.entry.checksState {
                        Image(systemName: state == "passing" ? "checkmark.circle" : state == "failing" ? "xmark.circle" : "clock")
                            .foregroundStyle(state == "passing" ? T3Colors.success : state == "failing" ? T3Colors.danger : T3Colors.textTertiary)
                            .accessibilityLabel("Checks \(state)")
                    }
                    Spacer(minLength: 0)
                    if row.sizeKnown {
                        Text("+\(row.entry.additions)").foregroundStyle(T3Colors.diffAddition)
                        Text("−\(row.entry.deletions)").foregroundStyle(T3Colors.diffDeletion)
                    }
                }.font(T3Typography.homeMetadata).foregroundStyle(T3Colors.textSecondary)
                HStack {
                    Text([row.entry.host, environmentName].compactMap { $0 }.joined(separator: " · ")).lineLimit(1)
                    Spacer(minLength: 4)
                    if let relative = PullRequestDetailSections.relativeLabel(row.entry.updatedAt) { Text(relative).fixedSize() }
                }.font(T3Typography.homeMetadata).foregroundStyle(T3Colors.textTertiary)
                if !searchText.isEmpty, NativePullRequestWorkspaceLogic.matchScore(row.entry, searchText) <= 10 {
                    Label("Matched on host", systemImage: "magnifyingglass").font(T3Typography.homeMetadata).foregroundStyle(T3Colors.textSecondary)
                }
                if !row.entry.labels.isEmpty {
                    ViewThatFits(in: .horizontal) {
                        labelPills(limit: 3).fixedSize(horizontal: true, vertical: false)
                        labelPills(limit: 2).fixedSize(horizontal: true, vertical: false)
                        labelPills(limit: 1)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func labelPills(limit: Int) -> some View {
        HStack(spacing: 5) {
            ForEach(Array(row.entry.labels.prefix(limit).enumerated()), id: \.offset) { index, label in
                HStack(spacing: 4) {
                    Circle().fill(labelColor(label.color)).frame(width: 6, height: 6)
                    Text(label.name).lineLimit(1)
                    if index == min(limit, row.entry.labels.count) - 1 && row.entry.labels.count > limit { Text("+\(row.entry.labels.count - limit)").fixedSize() }
                }.font(T3Typography.homeMetadata).foregroundStyle(T3Colors.textSecondary)
                    .padding(.horizontal, 6).padding(.vertical, 3).background(T3Colors.surface, in: Capsule())
                    .overlay(Capsule().stroke(T3Colors.border, lineWidth: 1))
            }
        }
    }

    private func labelColor(_ value: String?) -> Color {
        guard let value, value.count == 6, let hex = UInt32(value, radix: 16) else { return T3Colors.textSecondary }
        return Color(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255)
    }
}

/// Filters apply as they change, so the sheet only needs a close button.
private struct PullRequestWorkspaceFilters: View {
    @Binding var preferences: NativePullRequestPreferences
    let environments: [FeatureEnvironment]
    let projects: [FeatureProject]
    let hosts: [String]

    var body: some View {
        NavigationStack {
            Form {
                Section("Scope") {
                    Picker("Environment", selection: $preferences.environmentID) {
                        Text("All environments").tag(String?.none)
                        ForEach(environments) { Text($0.name).tag(Optional($0.id)) }
                    }.onChange(of: preferences.environmentID) { preferences.projectID = nil }
                    Picker("Project", selection: $preferences.projectID) {
                        Text("All projects").tag(String?.none)
                        ForEach(projects.filter { preferences.environmentID == nil || $0.environmentID == preferences.environmentID }) {
                            Text($0.name).tag(Optional($0.id))
                        }
                    }
                    Picker("Host", selection: $preferences.host) {
                        Text("All hosts").tag(String?.none)
                        ForEach(Array(Set(hosts + [preferences.host].compactMap { $0 })).sorted(), id: \.self) { Text($0).tag(Optional($0)) }
                    }
                }
                .t3GroupedRow()
                Section("Pull Requests") {
                    Picker("State", selection: $preferences.state) {
                        ForEach(NativePullRequestPreferences.stateOptions, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    Picker("Involvement", selection: $preferences.involvement) {
                        ForEach(NativePullRequestPreferences.involvementOptions, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    Picker("Sort", selection: $preferences.sort) {
                        ForEach(NativePullRequestPreferences.sortOptions, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    Picker("Drafts", selection: $preferences.draft) {
                        Text("Include drafts").tag(String?.none); Text("Hide drafts").tag(Optional("hide")); Text("Only drafts").tag(Optional("only"))
                    }
                    Picker("Review", selection: $preferences.review) {
                        Text("Any").tag(String?.none)
                        ForEach(["approved", "changes-requested", "review-required", "none"], id: \.self) { Text($0.replacingOccurrences(of: "-", with: " ").capitalized).tag(Optional($0)) }
                    }
                    Picker("Checks", selection: $preferences.checks) {
                        Text("Any").tag(String?.none); Text("Passing").tag(Optional("passing")); Text("Failing").tag(Optional("failing"))
                    }
                    LabeledContent("Author") {
                        TextField("Author login", text: $preferences.author, prompt: Text("Anyone"))
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                }
                .t3GroupedRow()
                Section {
                    LabeledContent("Include") {
                        TextField("Include labels", text: $preferences.labels, prompt: Text("Any"))
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Exclude") {
                        TextField("Exclude labels", text: $preferences.excludedLabels, prompt: Text("None"))
                            .multilineTextAlignment(.trailing)
                    }
                } header: { Text("Labels") } footer: { Text("Separate labels with commas. Include matches any listed label; exclude hides changes with any listed label. Host support varies.") }
                    .t3GroupedRow()
                Section {
                    Button("Reset Filters") { preferences = NativePullRequestPreferences() }
                        .disabled(preferences == NativePullRequestPreferences())
                }
                .t3GroupedRow()
            }
            .glassSheetFormBackground()
            .navigationTitle("Filters").navigationBarTitleDisplayMode(.inline)
            .t3SheetToolbar(.close)
            .t3NavigationChrome()
        }
        .presentationDetents([.medium, .large])
    }
}

extension NativePullRequestPreferences {
    static let stateOptions = [("open", "Open"), ("merged", "Merged"), ("closed", "Closed"), ("all", "All")]
    static let involvementOptions = [("all", "Everyone"), ("authored", "Authored by me"), ("reviewing", "My reviews")]
    static let sortOptions = [("ready", "Merge readiness"), ("blocked", "Blocked on me"), ("updated", "Recently updated"), ("newest", "Newest"), ("oldest", "Oldest"), ("largest", "Largest changes"), ("smallest", "Smallest changes")]

    /// Whether anything besides search and sort narrows the list: a scope, or a
    /// filter that changes what the hosts are asked for. Fills the filter button.
    var hasActiveFilters: Bool {
        var unsearched = self
        unsearched.query = ""
        return environmentID != nil || projectID != nil
            || unsearched.input(projectIDs: []) != Self().input(projectIDs: [])
    }

    /// The sheet's subtitle, e.g. "Open · Everyone · Merge readiness", led by the
    /// chosen project or environment when the list is scoped to one.
    func summary(environments: [FeatureEnvironment], projects: [FeatureProject]) -> String {
        let scope = projectID.flatMap { id in projects.first { $0.id == id }?.name }
            ?? environmentID.flatMap { id in environments.first { $0.id == id }?.name }
        let label = { (options: [(String, String)], value: String) in options.first { $0.0 == value }?.1 }
        return [scope, label(Self.stateOptions, state), label(Self.involvementOptions, involvement), label(Self.sortOptions, sort)]
            .compactMap { $0 }.joined(separator: " · ")
    }

    /// Why the saved environment or project can't be listed, naming the
    /// environment when it is known; nil while the saved scope is available.
    func unavailableScopeDescription(environments: [FeatureEnvironment], projects: [FeatureProject]) -> String? {
        if let environmentID, !environments.contains(where: { $0.id == environmentID && $0.supportsPullRequests == true }) {
            guard let environment = environments.first(where: { $0.id == environmentID }) else {
                return "The saved environment isn't available. Reconnect it or show every project."
            }
            if environment.connectionState == .connected {
                return "\(environment.name) can't list pull requests. Choose another scope or show every project."
            }
            return "\(environment.name) isn't connected. Reconnect it or show every project."
        }
        if let projectID, !projects.contains(where: { $0.id == projectID }) {
            return "The saved project isn't available. Reconnect its environment or show every project."
        }
        return nil
    }
}

private extension View {
    /// Inline title with the scope and sort underneath: the system subtitle on
    /// iOS 26, a two-line principal item before that.
    @ViewBuilder
    func pullRequestTitle(_ title: String, subtitle: String) -> some View {
        if #available(iOS 26, *) {
            navigationTitle(title).navigationSubtitle(subtitle)
        } else {
            navigationTitle(title).toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(title).font(T3Typography.navigationTitle).foregroundStyle(T3Colors.textPrimary)
                        Text(subtitle).font(T3Typography.navigationMetadata).foregroundStyle(T3Colors.textSecondary)
                    }
                    .lineLimit(1)
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isHeader)
                }
            }
        }
    }

    /// A medium-detent form sheet floats as glass on iOS 26, so the form keeps
    /// its background clear there; earlier systems paint the palette.
    @ViewBuilder
    func glassSheetFormBackground() -> some View {
        if #available(iOS 26, *) {
            scrollContentBackground(.hidden)
        } else {
            t3GroupedListBackground()
        }
    }
}
