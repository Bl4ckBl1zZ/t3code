import SwiftUI

struct NativeStackAction: Identifiable {
    let id = UUID()
    let stack: PullRequestStack
    let number: Int
    let action: String
    let mergeMethods: [String]
    var layers: [PullRequestStack.Layer] { stack.affectedLayers(number: number, action: action) }
}

/// Holds the exact stack the reader reviewed; a refresh must never alter an armed operation.
struct PullRequestStackActionSheet: View {
    let request: NativeStackAction
    let client: any FeatureClient
    let threadID: String
    let onFinished: () -> Void
    @State private var method = ""
    @State private var isBusy = false
    @State private var errorMessage: String?

    private var isMerge: Bool { request.action == "merge" }
    private var ready: Bool {
        !request.layers.isEmpty && request.layers.allSatisfy { $0.state == .open && $0.headSha != nil }
            && (!isMerge || request.mergeMethods.contains(method))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(isMerge ? "Merge through #\(request.number)" : "Rebase stack")
                        .font(T3Typography.threadHeading2)
                    Text("These layers will be updated on GitHub. Your local checkout stays unchanged.")
                        .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                    ThreadDetailsSection(title: "Affected layers") {
                        ForEach(request.layers) { layer in
                            ThreadDetailsRow(systemImage: "arrow.triangle.pull", title: "#\(layer.number) \(layer.title ?? layer.headBranch)",
                                subtitle: String((layer.headSha ?? "Revision unavailable").prefix(12)), showsChevron: false)
                        }
                    }
                    if isMerge {
                        Picker("Merge strategy", selection: $method) {
                            ForEach(request.mergeMethods, id: \.self) { Text($0.capitalized).tag($0) }
                        }
                    }
                    if let errorMessage {
                        Text(errorMessage).foregroundStyle(T3Colors.danger)
                        Text("Earlier completed updates remain on GitHub. Close this sheet to refresh before another attempt.")
                            .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                    }
                    if !ready {
                        Text("Refresh the stack to load every open layer’s revision before continuing.")
                            .font(T3Typography.supporting).foregroundStyle(T3Colors.warning)
                    }
                    SettingsActionButton(title: isMerge ? "Merge reviewed layers" : "Rebase reviewed layers",
                        systemImage: "arrow.triangle.merge", tone: .primary, isBusy: isBusy,
                        isDisabled: !ready || errorMessage != nil, action: perform)
                }.padding(16)
            }
            .background(T3Colors.background)
            .navigationTitle("Confirm stack action")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close", action: onFinished).disabled(isBusy) } }
            .t3NavigationChrome()
        }
        .interactiveDismissDisabled(isBusy)
        .onAppear { method = request.mergeMethods.first ?? "" }
    }

    private func perform() {
        guard ready, !isBusy, errorMessage == nil else { return }
        isBusy = true
        Task { @MainActor in
            do {
                try await client.runPullRequestStackAction(threadID: threadID, number: request.number,
                    stack: request.stack, action: request.action, mergeMethod: isMerge ? method : nil)
                onFinished()
            } catch { errorMessage = error.localizedDescription }
            isBusy = false
        }
    }
}
