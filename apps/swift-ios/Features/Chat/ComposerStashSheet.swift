import SwiftUI

struct ComposerStashSheet: View {
    let entries: [FeatureComposerStashEntry]
    let busy: Bool
    let error: String?
    let restore: (FeatureComposerStashEntry) -> Void
    let remove: (FeatureComposerStashEntry) -> Void
    @State private var pendingRemoval: FeatureComposerStashEntry?

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                if let error { Text(error).font(T3Typography.supporting).foregroundStyle(T3Colors.danger) }
                if entries.isEmpty {
                    ContentUnavailableView("No stashed drafts", systemImage: "bookmark",
                        description: Text("Save a draft from the composer’s prompt history menu."))
                }
                ForEach(entries.reversed()) { entry in
                    VStack(alignment: .leading, spacing: 12) {
                        Text(entry.draft.text.isEmpty ? "Attachments" : AssistantCitation.plainText(entry.draft.text))
                            .font(T3Typography.threadBody).foregroundStyle(T3Colors.textPrimary)
                            .lineLimit(6).frame(maxWidth: .infinity, alignment: .leading)
                        if !entry.draft.attachments.isEmpty {
                            Label(entry.draft.attachments.map(\.filename).joined(separator: ", "), systemImage: "paperclip")
                                .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).lineLimit(2)
                        }
                        HStack {
                            Button("Restore") { restore(entry) }
                                .frame(minHeight: T3Metrics.minimumTapTarget)
                            Spacer()
                            Button("Remove", role: .destructive) { pendingRemoval = entry }
                                .frame(minHeight: T3Metrics.minimumTapTarget)
                        }.disabled(busy)
                    }.padding(16).background(T3Colors.surfaceRaised, in: RoundedRectangle(cornerRadius: 16))
                }
                Text("Restoring a draft saves any unsent text and attachments in the stash first.")
                    .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
            }.padding(16)
        }
        .background(T3Colors.background)
        .navigationTitle("Stashed drafts").navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Remove this stashed draft?", isPresented: Binding(get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } }), titleVisibility: .visible) {
            Button("Remove draft", role: .destructive) { if let entry = pendingRemoval { remove(entry) }; pendingRemoval = nil }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        }
    }
}
