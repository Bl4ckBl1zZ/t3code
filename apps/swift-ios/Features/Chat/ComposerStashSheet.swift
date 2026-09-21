import SwiftUI

/// The drafts stashed from this composer. Tapping a row restores it (the
/// current draft is stashed first); swiping deletes, after a confirmation.
struct ComposerStashSheet: View {
    let entries: [FeatureComposerStashEntry]
    let busy: Bool
    let error: String?
    let restore: (FeatureComposerStashEntry) -> Void
    let remove: (FeatureComposerStashEntry) -> Void

    @State private var pendingRemoval: FeatureComposerStashEntry?
    @State private var restoringID: String?

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.danger)
                            .t3SheetRow()
                    }
                }
                Section {
                    ForEach(entries.reversed()) { entry in
                        row(entry)
                    }
                } footer: {
                    if !entries.isEmpty {
                        Text("Tap a draft to restore it. Whatever is in the composer is stashed first.")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .t3SheetListBackground()
            .overlay {
                if entries.isEmpty {
                    ContentUnavailableView(
                        "No Stashed Drafts",
                        systemImage: "bookmark",
                        description: Text("Stash a draft from the composer’s + menu to come back to it later.")
                    )
                }
            }
            .navigationTitle("Stashed Drafts")
            .navigationBarTitleDisplayMode(.inline)
            .t3SheetToolbar(.close)
            .t3NavigationChrome()
            .confirmationDialog(
                "Remove this stashed draft?",
                isPresented: Binding(get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } }),
                titleVisibility: .visible
            ) {
                Button("Remove Draft", role: .destructive) {
                    if let entry = pendingRemoval { remove(entry) }
                    pendingRemoval = nil
                }
                Button("Cancel", role: .cancel) { pendingRemoval = nil }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onChange(of: busy) { _, isBusy in
            if !isBusy { restoringID = nil }
        }
    }

    private func row(_ entry: FeatureComposerStashEntry) -> some View {
        Button {
            restoringID = entry.id
            restore(entry)
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.draft.text.isEmpty ? "Attachments" : AssistantCitation.plainText(entry.draft.text))
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(3)
                    if !entry.draft.attachments.isEmpty {
                        Label(attachmentSummary(entry), systemImage: "paperclip")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if restoringID == entry.id, busy {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Delete", systemImage: "trash", role: .destructive) {
                pendingRemoval = entry
            }
        }
        .accessibilityHint("Restores this draft into the composer")
        .t3SheetRow()
    }

    private func attachmentSummary(_ entry: FeatureComposerStashEntry) -> String {
        let count = entry.draft.attachments.count
        return count == 1 ? "1 attachment" : "\(count) attachments"
    }
}
