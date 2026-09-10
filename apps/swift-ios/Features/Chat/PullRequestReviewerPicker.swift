import SwiftUI

struct PullRequestReviewerPicker: View {
    let access: FeaturePullRequestReviewerAccess
    let allowed: Bool
    let changed: () async -> Void
    @State private var model = PullRequestReviewerModel()
    @State private var search = ""
    @SwiftUI.Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                if let error = model.error {
                    Section {
                        Text(error).foregroundStyle(T3Colors.warning)
                        Button("Retry") { Task { await model.load(read: access.load) } }.disabled(model.loading || model.pending != nil)
                    }
                }
                if model.loading && model.candidates.isEmpty { ProgressView("Loading people with access…") }
                Section {
                    ForEach(model.matching(search), id: \.key) { candidate in
                        Button {
                            Task {
                                if await model.toggle(candidate, send: access.request) {
                                    await changed()
                                    await model.load(read: access.load)
                                }
                            }
                        } label: {
                            HStack(spacing: 10) {
                                PullRequestReviewerAvatar(candidate: candidate)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(candidate.login).font(T3Typography.supportingStrong)
                                    if let name = candidate.name, name != candidate.login { Text(name).font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary) }
                                }
                                Spacer()
                                if model.pending == candidate.key { ProgressView() }
                                else if candidate.isRequested { Image(systemName: "checkmark").foregroundStyle(T3Colors.accent) }
                            }.frame(minHeight: 44)
                        }
                        .buttonStyle(.plain)
                        .disabled(!allowed || model.pending != nil || model.loading || !["user", "team"].contains(candidate.kind))
                        .accessibilityValue(candidate.isRequested ? "Review requested" : "Not requested")
                        .accessibilityHint(candidate.isRequested ? "Take back the review request" : "Request a review")
                    }
                    if !model.loading && model.matching(search).isEmpty {
                        Text(search.isEmpty ? "No other reviewers were returned by this host." : "No listed people match this search.")
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                } footer: {
                    if model.truncated { Text("This repository has more people with access than are listed here. Search filters only this list; request other reviewers on the host.") }
                    if !allowed { Text("Requesting reviewers needs write access on this repository.") }
                }
            }
            .scrollContentBackground(.hidden).background(T3Colors.background)
            .navigationTitle("Request reviewers").navigationBarTitleDisplayMode(.inline)
            .searchable(text: $search, prompt: "Search people with access")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(model.pending != nil) } }
            .interactiveDismissDisabled(model.pending != nil)
            .task { await model.load(read: access.load) }
        }
    }
}

private struct PullRequestReviewerAvatar: View {
    let candidate: PullRequestReviewerCandidate
    private var url: URL? {
        guard let value = candidate.avatarUrl.flatMap(URL.init(string:)), ["https", "http"].contains(value.scheme?.lowercased() ?? "") else { return nil }
        return value
    }
    var body: some View {
        AsyncImage(url: url) { phase in
            if let image = phase.image { image.resizable().scaledToFill() }
            else {
                ZStack {
                    Circle().fill(T3Colors.subtle)
                    Image(systemName: candidate.kind == "team" ? "person.3" : "person.crop.circle").foregroundStyle(T3Colors.textSecondary)
                }
            }
        }.frame(width: 28, height: 28).clipShape(Circle()).accessibilityHidden(true)
    }
}
