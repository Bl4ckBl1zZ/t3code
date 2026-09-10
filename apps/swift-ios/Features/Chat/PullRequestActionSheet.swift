import SwiftUI

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
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("#\(detail.number) · \(detail.title)").font(T3Typography.supportingStrong)
                    Text("\(detail.headBranch) → \(detail.baseBranch)").font(T3Typography.supporting.monospaced())
                    Text(action.explanation).foregroundStyle(T3Colors.textSecondary)
                    if !methods.isEmpty {
                        Picker("Method", selection: $method) {
                            ForEach(methods, id: \.self) { Text($0.capitalized).tag($0) }
                        }
                    }
                    if let error { Text(error).foregroundStyle(T3Colors.warning) }
                    Button(role: action == .close ? .destructive : nil) {
                        pending = true; error = nil
                        Task {
                            defer { pending = false }
                            do {
                                try await perform(.init(action: action.rawValue,
                                    mergeMethod: action == .merge || action == .enableAutoMerge ? method : nil,
                                    updateMethod: action == .updateBranch ? method : nil))
                                dismiss(); completed()
                            } catch { self.error = error.localizedDescription }
                        }
                    } label: { HStack { Text(action.label); if pending { ProgressView() } } }
                        .disabled(pending || (!methods.isEmpty && !methods.contains(method)))
                }
            }
            .scrollContentBackground(.hidden).background(T3Colors.background)
            .navigationTitle(action.label).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(pending) } }
            .interactiveDismissDisabled(pending)
            .onAppear { if !methods.contains(method) { method = methods.first ?? "" } }
        }
    }
}
