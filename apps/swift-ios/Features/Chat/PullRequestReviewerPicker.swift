import SwiftUI

/// People with access to the repository, pushed from a pull request's
/// Reviewers section. A tap requests or withdraws a review at once.
struct PullRequestReviewerPicker: View {
    let access: FeaturePullRequestReviewerAccess
    let allowed: Bool
    let changed: () async -> Void
    @State private var model = PullRequestReviewerModel()
    @State private var search = ""

    var body: some View {
        let matching = model.matching(search)
        List {
            if let error = model.error {
                Section {
                    HStack {
                        Label(error, systemImage: "exclamationmark.circle")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.danger)
                        Spacer(minLength: 8)
                        Button("Retry") { Task { await model.load(read: access.load) } }
                            .buttonStyle(.bordered)
                            .tint(T3Colors.textPrimary)
                            .disabled(model.loading || model.pending != nil)
                    }
                }
                .t3GroupedRow()
            }
            if model.loading && model.candidates.isEmpty {
                Section {
                    ForEach(0..<4, id: \.self) { _ in
                        Label("Person Name", systemImage: "person.crop.circle.fill")
                            .redacted(reason: .placeholder)
                    }
                }
                .t3GroupedRow()
                .accessibilityHidden(true)
            } else if matching.isEmpty, model.error == nil {
                Group {
                    if search.isEmpty {
                        ContentUnavailableView("No Reviewers", systemImage: "person.2",
                            description: Text("No other reviewers were returned by this host."))
                    } else {
                        ContentUnavailableView.search(text: search)
                    }
                }
                .listRowBackground(Color.clear)
            } else {
                Section {
                    ForEach(matching, id: \.key) { candidate in
                        row(candidate)
                    }
                } header: {
                    Text("People with Access")
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        if model.truncated { Text("Not everyone with access is listed. Search filters only this list; request anyone else on the host.") }
                        if !allowed { Text("Requesting reviewers needs write access on this repository.") }
                    }
                }
                .t3GroupedRow()
            }
        }
        .t3SheetList()
        .t3GroupedListBackground()
        .navigationTitle("Reviewers")
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
        .t3Searchable(text: $search, prompt: Text("Search People"))
        .task { await model.load(read: access.load) }
    }

    private func row(_ candidate: PullRequestReviewerCandidate) -> some View {
        let canRequest = ["user", "team"].contains(candidate.kind)
        return Button {
            PlatformHapticEngine.shared.playSelection()
            Task {
                if await model.toggle(candidate, send: access.request) {
                    await changed()
                } else if model.error != nil {
                    PlatformHapticEngine.shared.play(.error)
                }
            }
        } label: {
            HStack(spacing: 12) {
                PullRequestAvatar(login: candidate.login, avatarURL: candidate.avatarUrl, isTeam: candidate.kind == "team")
                VStack(alignment: .leading, spacing: 2) {
                    Text(candidate.name.flatMap { $0.isEmpty ? nil : $0 } ?? candidate.login)
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.textPrimary)
                    if let name = candidate.name, !name.isEmpty, name != candidate.login {
                        Text(candidate.login)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                }
                Spacer(minLength: 8)
                if model.pending == candidate.key {
                    ProgressView()
                } else if !canRequest {
                    Text("Can’t Be Requested")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                } else if candidate.isRequested {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(T3Colors.accent)
                }
            }
        }
        .disabled(!allowed || model.pending != nil || model.loading || !canRequest)
        .accessibilityValue(candidate.isRequested ? "Review requested" : "Not requested")
        .accessibilityHint(candidate.isRequested ? "Take back the review request" : "Request a review")
    }
}
