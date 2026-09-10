import SwiftUI
import UIKit

struct PullRequestWorkspaceView: View {
    @Bindable var model: FeatureRootModel
    let manager: any FeatureProjectPullRequestManaging
    @SwiftUI.Environment(\.dismiss) private var dismiss
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

    var body: some View {
        NavigationStack {
            content
                .background(T3Colors.background)
                .navigationTitle("Pull requests").navigationBarTitleDisplayMode(.inline)
                .searchable(text: $preferences.query, prompt: "Search pull requests")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showingFilters = true } label: { Image(systemName: "line.3.horizontal.decrease") }
                            .accessibilityLabel("Filter and sort pull requests")
                    }
                }
                .t3NavigationChrome()
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
            ContentUnavailableView("Pull requests unavailable", systemImage: "arrow.triangle.pull",
                description: Text("Connect to an environment that supports pull requests."))
        } else if (preferences.environmentID != nil && !supportedEnvironments.contains(where: { $0.id == preferences.environmentID })) ||
                    (preferences.projectID != nil && !model.snapshot.projects.contains(where: { $0.id == preferences.projectID })) {
            VStack(spacing: 12) {
                ContentUnavailableView("Saved scope unavailable", systemImage: "server.rack",
                    description: Text("The saved environment or project is not currently available. Reconnect it or choose another scope."))
                Button("Show all projects") { preferences.environmentID = nil; preferences.projectID = nil }
                    .frame(minHeight: 44).padding(.bottom, 24)
            }
        } else {
            let rows = feed.rows(preferences: preferences)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text("\(rows.count) loaded").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                        Spacer()
                        if feed.loading { ProgressView().accessibilityLabel("Loading pull requests") }
                        Menu {
                            ForEach(PullRequestWorkspaceFilters.sorts, id: \.0) { value, label in
                                Button { preferences.sort = value } label: {
                                    if preferences.sort == value { Label(label, systemImage: "checkmark") } else { Text(label) }
                                }
                            }
                        } label: {
                            Label(PullRequestWorkspaceFilters.sorts.first { $0.0 == preferences.sort }?.1 ?? "Merge readiness", systemImage: "arrow.up.arrow.down")
                                .font(T3Typography.supporting).frame(minHeight: 44)
                        }
                    }.padding(.horizontal, 18)
                    ForEach(feed.messages, id: \.self) { message in
                        SettingsErrorBanner(message: message).padding(.horizontal, 18).padding(.bottom, 10)
                    }
                    if !feed.localSearchHosts.isEmpty && !preferences.query.isEmpty {
                        Text("\(feed.localSearchHosts.joined(separator: ", ")) searches loaded rows. Load more to search older changes.")
                            .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).padding(18)
                    }
                    if rows.isEmpty && !feed.loading {
                        ContentUnavailableView("No matching pull requests", systemImage: "arrow.triangle.pull",
                            description: Text("Change the filters or refresh your environments."))
                        Button("Refresh") { Task { await reload() } }.frame(maxWidth: .infinity, minHeight: 44)
                    }
                    ForEach(preferences.involvement == "all" ? [0, 1, 2] : [0], id: \.self) { group in
                        let entries = preferences.involvement == "all" ? rows.filter { $0.group == group } : rows
                        if !entries.isEmpty {
                            if preferences.involvement == "all" {
                                Text(["Authored by you", "Review requested", "Other pull requests"][group])
                                    .font(T3Typography.supportingStrong).foregroundStyle(T3Colors.textSecondary)
                                    .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 8)
                            }
                            ForEach(entries) { row in
                                NavigationLink {
                                    PullRequestDetailSheet(access: FeaturePullRequestAccess(manager: manager, scope: .init(projectID: row.projectID, host: row.entry.host, repository: row.entry.repository)), number: row.entry.number)
                                } label: {
                                    PullRequestWorkspaceRow(row: row, environmentName: model.snapshot.environments.first { $0.id == row.environmentID }?.name,
                                        project: model.snapshot.projects.first { $0.id == row.projectID }, searchText: preferences.query)
                                }.buttonStyle(.plain)
                                    .onAppear { visibleRowIDs.insert(row.id) }
                                    .onDisappear { visibleRowIDs.remove(row.id) }
                                Divider().padding(.leading, 48)
                            }
                        }
                    }
                    if feed.hasMore {
                        Button("Load more") { Task { await feed.loadMore(manager: manager, preferences: preferences) } }
                            .disabled(feed.loading).frame(maxWidth: .infinity, minHeight: 48).padding(.vertical, 12)
                    }
                    if feed.reachedHostLimit {
                        Text("This host cannot page beyond the loaded limit. Narrow the search or open the host for older changes.")
                            .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).padding(18)
                    }
                    if feed.loadingStats {
                        Text("Loading change sizes…").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).padding(18)
                    }
                }.padding(.bottom, 24)
            }.refreshable { await reload() }
        }
    }

    private func reload() async {
        await feed.reload(manager: manager, environments: model.snapshot.environments, projects: model.snapshot.projects, preferences: preferences)
    }
}

private struct PullRequestWorkspaceRow: View {
    let row: NativePullRequestRow
    let environmentName: String?
    let project: FeatureProject?
    let searchText: String
    @SwiftUI.Environment(\.openURL) private var openURL
    private var color: Color {
        switch row.entry.state {
        case .merged: .purple
        case .closed: T3Colors.danger
        case .open: row.entry.isDraft ? T3Colors.textTertiary : T3Colors.success
        }
    }
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: row.entry.state == .merged ? "arrow.triangle.merge" : "arrow.triangle.pull")
                .font(.system(size: 17)).foregroundStyle(color).frame(width: 20).padding(.top, 2)
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
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(T3Colors.textTertiary)
        }.padding(.horizontal, 18).padding(.vertical, 14).frame(minHeight: 44).contentShape(Rectangle())
        .contextMenu {
            if let url = URL(string: row.entry.url), ["https", "http"].contains(url.scheme ?? "") {
                Button("Open on host", systemImage: "arrow.up.right.square") { openURL(url) }
                Button("Copy link", systemImage: "link") { UIPasteboard.general.string = url.absoluteString }
            }
        }
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

private struct PullRequestWorkspaceFilters: View {
    @Binding var preferences: NativePullRequestPreferences
    let environments: [FeatureEnvironment]
    let projects: [FeatureProject]
    let hosts: [String]
    @SwiftUI.Environment(\.dismiss) private var dismiss
    static let sorts = [("ready", "Merge readiness"), ("updated", "Recently updated"), ("newest", "Newest"), ("oldest", "Oldest"), ("largest", "Largest changes"), ("smallest", "Smallest changes")]

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
                Section("Pull requests") {
                    Picker("State", selection: $preferences.state) {
                        Text("Open").tag("open"); Text("Merged").tag("merged"); Text("Closed").tag("closed"); Text("All").tag("all")
                    }
                    Picker("Involvement", selection: $preferences.involvement) {
                        Text("Everyone").tag("all"); Text("Authored by me").tag("authored"); Text("My reviews").tag("reviewing")
                    }
                    Picker("Sort", selection: $preferences.sort) { ForEach(Self.sorts, id: \.0) { Text($0.1).tag($0.0) } }
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
                    TextField("Author login", text: $preferences.author).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Section {
                    TextField("Include labels", text: $preferences.labels)
                    TextField("Exclude labels", text: $preferences.excludedLabels)
                } header: { Text("Labels") } footer: { Text("Separate labels with commas. Include matches any listed label; exclude hides changes with any listed label. Host support varies.") }
                Section { Button("Reset filters") { preferences = NativePullRequestPreferences() } }
            }
            .scrollContentBackground(.hidden).background(T3Colors.background)
            .navigationTitle("Filters and sorting").navigationBarTitleDisplayMode(.inline).t3NavigationChrome()
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
