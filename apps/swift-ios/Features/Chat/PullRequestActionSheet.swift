import SwiftUI

/// Confirms a pull request action that has something to choose or review
/// first: merge, auto-merge, update branch, revert, approve workflows. A
/// short sheet; the confirm button in the toolbar runs it.
struct PullRequestActionSheet: View {
    let action: NativePullRequestAction
    let detail: PullRequestDetail
    let perform: (PullRequestActionRequest) async throws -> Void
    let completed: () -> Void
    @State private var method = ""
    @State private var pending = false
    @State private var error: String?
    @SwiftUI.Environment(\.dismiss) private var dismiss
    private var methods: [String] {
        switch action {
        case .merge, .enableAutoMerge: PullRequestActionLogic.mergeMethods(detail)
        case .updateBranch: PullRequestActionLogic.updateMethods(detail)
        default: []
        }
    }
    private var title: String {
        action.label.replacingOccurrences(of: "…", with: "")
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("#\(detail.number)") {
                        Text(detail.title).lineLimit(2)
                    }
                    Text(PullRequestDetailSections.branchLine(detail))
                        .font(T3Typography.tool)
                        .foregroundStyle(T3Colors.textSecondary)
                    if !methods.isEmpty {
                        Picker("Method", selection: $method) {
                            ForEach(methods, id: \.self) {
                                Text(action == .updateBranch ? PullRequestActionLogic.updateMethodLabel($0) : PullRequestActionLogic.methodLabel($0)).tag($0)
                            }
                        }
                        .pickerStyle(.menu)
                        .disabled(pending)
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(action.explanation)
                            .foregroundStyle(action == .updateBranch && method == "rebase" ? T3Colors.warning : T3Colors.textSecondary)
                        if let error {
                            Text("\(action.failureTitle). \(error)").foregroundStyle(T3Colors.danger)
                        }
                    }
                }
                .t3GroupedRow()
            }
            .t3GroupedListBackground()
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(
                    title: action.confirmLabel,
                    isEnabled: methods.isEmpty || methods.contains(method),
                    isBusy: pending,
                    action: run
                )
            )
            .interactiveDismissDisabled(pending)
            .onAppear { if !methods.contains(method) { method = detail.autoMergeMethod.flatMap { methods.contains($0) ? $0 : nil } ?? methods.first ?? "" } }
        }
        .presentationDetents([.medium])
        .t3GlassSheetBackground()
    }

    private func run() {
        guard !pending else { return }
        pending = true; error = nil
        Task {
            defer { pending = false }
            do {
                try await perform(.init(action: action.rawValue,
                    mergeMethod: action == .merge || action == .enableAutoMerge ? method : nil,
                    updateMethod: action == .updateBranch ? method : nil))
                // The merged state is what the reader came for; say it landed.
                if action == .merge { T3HUD.show("Merged #\(detail.number)", systemImage: "arrow.triangle.merge") }
                else { PlatformHapticEngine.shared.play(.success) }
                dismiss(); completed()
            } catch {
                self.error = error.localizedDescription
                PlatformHapticEngine.shared.play(.error)
            }
        }
    }
}
