import SwiftUI

/// The repository's labels, pushed from a pull request's Labels section.
/// Each toggle applies at once and updates its own row in place: the list
/// never reloads under the reader's finger.
struct PullRequestLabelPickerSheet: View {
    let access: FeaturePullRequestAccess
    let number: Int
    /// Reloads the pull request behind this screen once it closes, if a toggle
    /// landed.
    let changed: () async -> Void
    @State private var result: PullRequestLabelCandidateList?
    @State private var query = ""
    @State private var pending: String?
    @State private var loading = true
    @State private var loadError: String?
    @State private var toggleError: String?
    @State private var didChange = false

    private var candidates: [PullRequestLabelCandidate] {
        (result?.candidates ?? []).filter {
            query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)
                || ($0.description?.localizedCaseInsensitiveContains(query) ?? false)
        }
    }

    var body: some View {
        List {
            if loading, result == nil {
                Section {
                    ForEach(0..<5, id: \.self) { _ in
                        Label("Label name", systemImage: "circle.fill")
                            .redacted(reason: .placeholder)
                    }
                }
                .t3GroupedRow()
                .accessibilityHidden(true)
            } else if let loadError, result == nil {
                ContentUnavailableView {
                    Label("Couldn’t Load Labels", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(loadError)
                } actions: {
                    Button("Try Again") { Task { await load() } }.buttonStyle(.bordered)
                }
                .listRowBackground(Color.clear)
            } else if candidates.isEmpty {
                Group {
                    if query.isEmpty {
                        ContentUnavailableView("No Labels", systemImage: "tag", description: Text("This repository has no labels."))
                    } else {
                        ContentUnavailableView.search(text: query)
                    }
                }
                .listRowBackground(Color.clear)
            } else {
                Section {
                    ForEach(candidates) { candidate in
                        row(candidate)
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        if let toggleError {
                            Text(toggleError).foregroundStyle(T3Colors.danger)
                        }
                        if result?.truncated == true {
                            Text("This repository has more labels than are listed here. Apply the rest on the host.")
                        }
                    }
                }
                .t3GroupedRow()
            }
        }
        .t3SheetList()
        .t3GroupedListBackground()
        .navigationTitle("Labels")
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
        .searchable(text: $query, prompt: "Search Labels")
        .task { await load() }
        .onDisappear {
            if didChange { Task { await changed() } }
        }
    }

    private func row(_ candidate: PullRequestLabelCandidate) -> some View {
        Button { toggle(candidate) } label: {
            HStack(spacing: 12) {
                PullRequestLabelSwatch(hex: candidate.color)
                VStack(alignment: .leading, spacing: 2) {
                    Text(candidate.name)
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.textPrimary)
                    if let description = candidate.description, !description.isEmpty {
                        Text(description)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                }
                Spacer(minLength: 8)
                if pending == candidate.name {
                    ProgressView()
                } else if candidate.isApplied {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(T3Colors.accent)
                }
            }
        }
        .disabled(pending != nil)
        .accessibilityValue(candidate.isApplied ? "Applied" : "Not applied")
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let loaded = try await access.labels(number)
            guard !Task.isCancelled else { return }
            result = loaded
            loadError = nil
        } catch {
            guard !Task.isCancelled else { return }
            loadError = error.localizedDescription
        }
    }

    /// Applies one label and flips its row in place when the host agrees. A
    /// failure is reported under the list and leaves every row usable.
    private func toggle(_ candidate: PullRequestLabelCandidate) {
        guard pending == nil else { return }
        pending = candidate.name
        toggleError = nil
        PlatformHapticEngine.shared.playSelection()
        Task { @MainActor in
            defer { pending = nil }
            do {
                try await access.setLabels(number, [candidate.name], !candidate.isApplied)
                result = PullRequestLabelPicking.toggling(result, name: candidate.name)
                didChange = true
            } catch {
                toggleError = "Couldn’t update “\(candidate.name)”: \(error.localizedDescription)"
                PlatformHapticEngine.shared.play(.error)
            }
        }
    }
}

/// The label list after one toggle lands, without asking the host again.
enum PullRequestLabelPicking {
    static func toggling(_ list: PullRequestLabelCandidateList?, name: String) -> PullRequestLabelCandidateList? {
        guard let list else { return nil }
        return PullRequestLabelCandidateList(
            candidates: list.candidates.map { candidate in
                guard candidate.name == name else { return candidate }
                return PullRequestLabelCandidate(
                    name: candidate.name,
                    color: candidate.color,
                    description: candidate.description,
                    isApplied: !candidate.isApplied
                )
            },
            truncated: list.truncated
        )
    }
}
