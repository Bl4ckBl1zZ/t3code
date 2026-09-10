import SwiftUI

struct PullRequestLabelPickerSheet: View {
    let client: any FeatureClient
    let threadID: String
    let number: Int
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var result: PullRequestLabelCandidateList?
    @State private var query = ""
    @State private var pending: String?
    @State private var loading = true
    @State private var errorMessage: String?

    private var candidates: [PullRequestLabelCandidate] {
        (result?.candidates ?? []).filter {
            query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)
                || ($0.description?.localizedCaseInsensitiveContains(query) ?? false)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let errorMessage {
                        Text(errorMessage).font(T3Typography.supporting).foregroundStyle(T3Colors.danger)
                        Button("Refresh labels") { Task { await load() } }.disabled(pending != nil)
                    }
                    if loading {
                        ProgressView().frame(maxWidth: .infinity)
                    } else if candidates.isEmpty {
                        Text(query.isEmpty ? "This repository has no labels." : "No matching labels.")
                            .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                    } else {
                        ThreadDetailsSection(title: "Repository labels") {
                            ForEach(candidates) { candidate in
                                Button { toggle(candidate) } label: {
                                    HStack(spacing: 10) {
                                        Circle().fill(labelColor(candidate.color)).frame(width: 8, height: 8)
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(candidate.name).font(T3Typography.threadBody)
                                            if let description = candidate.description, !description.isEmpty {
                                                Text(description).font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                                            }
                                        }
                                        Spacer(minLength: 8)
                                        if pending == candidate.name { ProgressView() }
                                        else if candidate.isApplied { Image(systemName: "checkmark").accessibilityLabel("Applied") }
                                    }
                                    .foregroundStyle(T3Colors.textPrimary).padding(12).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .disabled(pending != nil || errorMessage != nil)
                                .accessibilityValue(candidate.isApplied ? "Applied" : "Not applied")
                            }
                        }
                    }
                    if result?.truncated == true {
                        Text("This repository has more labels than are listed here. Apply the rest on the host.")
                            .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                    }
                }.padding(16)
            }
            .background(T3Colors.background)
            .navigationTitle("Change labels")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Search labels")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(pending != nil) } }
            .t3NavigationChrome()
            .task { await load() }
        }
        .interactiveDismissDisabled(pending != nil)
    }

    private func labelColor(_ value: String?) -> Color {
        guard let value, value.count == 6, let hex = UInt32(value, radix: 16) else { return T3Colors.textSecondary }
        return Color(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255)
    }

    private func load() async {
        loading = true
        errorMessage = nil
        do {
            let loaded = try await client.pullRequestLabelCandidates(threadID: threadID, number: number)
            guard !Task.isCancelled else { return }
            result = loaded
        } catch {
            guard !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
        }
        loading = false
    }

    private func toggle(_ candidate: PullRequestLabelCandidate) {
        guard pending == nil, errorMessage == nil else { return }
        pending = candidate.name
        Task { @MainActor in
            do {
                try await client.setPullRequestLabels(threadID: threadID, number: number,
                    labels: [candidate.name], applied: !candidate.isApplied)
                await load()
            } catch { errorMessage = error.localizedDescription }
            pending = nil
        }
    }
}
