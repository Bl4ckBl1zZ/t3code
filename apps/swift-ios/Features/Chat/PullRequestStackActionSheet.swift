import SwiftUI

struct NativeStackAction: Identifiable {
    let id = UUID()
    let stack: PullRequestStack
    let number: Int
    let action: String
    let mergeMethods: [String]
    var layers: [PullRequestStack.Layer] { stack.affectedLayers(number: number, action: action) }
}

/// How a stack layer's revision reads in the confirmation.
enum PullRequestStackRevision {
    /// The first twelve characters of the SHA the action is pinned to; the
    /// fallback text is never shortened.
    static func label(_ headSha: String?) -> String {
        headSha.map { String($0.prefix(12)) } ?? "Revision unavailable"
    }
}

/// Holds the exact stack the reader reviewed; a refresh must never alter an armed operation.
struct PullRequestStackActionSheet: View {
    let request: NativeStackAction
    let access: FeaturePullRequestAccess
    /// Closes the sheet; the detail screen reloads the stack when it does.
    let onFinished: () -> Void
    @State private var method = ""
    @State private var isBusy = false
    @State private var errorMessage: String?

    private var isMerge: Bool { request.action == "merge" }
    private var hasEveryRevision: Bool {
        !request.layers.isEmpty && request.layers.allSatisfy { $0.state == .open && $0.headSha != nil }
    }
    private var ready: Bool {
        hasEveryRevision && (!isMerge || request.mergeMethods.contains(method))
    }

    var body: some View {
        NavigationStack {
            Form {
                if !hasEveryRevision {
                    Section {
                        ThreadSheetBanner(
                            tone: .warning,
                            title: "A layer has no revision",
                            message: "Refresh the stack to load every open layer’s revision before continuing."
                        ) {
                            Button("Refresh Stack", action: onFinished)
                        }
                        .listRowBackground(ThreadSheetBannerTone.warning.fill)
                    }
                }
                if let errorMessage {
                    Section {
                        ThreadSheetBanner(
                            tone: .error,
                            title: errorMessage,
                            message: "Earlier completed updates remain on GitHub. Close this sheet to refresh before another attempt."
                        )
                        .listRowBackground(ThreadSheetBannerTone.error.fill)
                    }
                }
                Section {
                    ForEach(request.layers) { layer in
                        LabeledContent {
                            Text(PullRequestStackRevision.label(layer.headSha))
                                .font(T3Typography.tool)
                                .foregroundStyle(layer.headSha == nil ? T3Colors.warning : T3Colors.textSecondary)
                        } label: {
                            Text("#\(layer.number) \(layer.title ?? layer.headBranch)")
                                .lineLimit(2)
                        }
                    }
                } header: {
                    Text("Affected Layers")
                } footer: {
                    Text("Layers update on GitHub from base to top. Your local checkout stays unchanged.")
                }
                .t3GroupedRow()
                if isMerge {
                    Section {
                        Picker("Method", selection: $method) {
                            ForEach(request.mergeMethods, id: \.self) { Text(PullRequestActionLogic.methodLabel($0)).tag($0) }
                        }
                        .pickerStyle(.menu)
                        .disabled(isBusy)
                    }
                    .t3GroupedRow()
                }
            }
            .t3GroupedListBackground()
            .navigationTitle(isMerge ? "Merge Through #\(request.number)" : "Rebase Stack")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(
                    title: isMerge ? "Merge" : "Rebase",
                    isEnabled: ready && errorMessage == nil,
                    isBusy: isBusy,
                    action: perform
                ),
                onDismiss: onFinished
            )
            .interactiveDismissDisabled(isBusy)
        }
        .presentationDetents([.medium, .large])
        .t3GlassSheetBackground()
        .onAppear { method = request.mergeMethods.first ?? "" }
    }

    private func perform() {
        guard ready, !isBusy, errorMessage == nil else { return }
        isBusy = true
        Task { @MainActor in
            do {
                try await access.runStackAction(request.number, request.stack, request.action, isMerge ? method : nil)
                PlatformHapticEngine.shared.play(.success)
                onFinished()
            } catch {
                errorMessage = error.localizedDescription
                PlatformHapticEngine.shared.play(.error)
            }
            isBusy = false
        }
    }
}
