import SwiftUI

/// The Pinned part of Arrange Threads: drag pinned threads into the order they
/// sit above the rest. Keys are written to each thread's own server
/// (``PinnedThreadOrder``), so web and every other device show the same run.
struct PinnedThreadArrangementSection: View {
    let model: FeatureRootModel
    /// Reorder-capable pins in their displayed order.
    let pinned: [FeatureThread]
    let contexts: [String: HomeThreadRowContext]
    let showsProject: Bool
    /// Shared with the Active section, so only one write runs at a time.
    @Binding var saving: Bool
    @Binding var error: String?
    @State private var rows: [FeatureThread] = []

    var body: some View {
        Section {
            ForEach(rows) { thread in
                ArrangementRow(
                    thread: thread,
                    context: contexts[thread.id] ?? .fallback,
                    showsProject: showsProject
                )
                .accessibilityAction(named: "Move Up") { move(thread.id, offset: -1) }
                .accessibilityAction(named: "Move Down") { move(thread.id, offset: 1) }
            }
            .onMove { source, destination in
                guard !saving, let index = source.first else { return }
                let id = rows[index].id
                rows.move(fromOffsets: source, toOffset: destination)
                save(movedID: id)
            }
            .moveDisabled(saving)
        } header: {
            Text("Pinned")
        } footer: {
            Text("Pinned threads stay above the rest, in this order.")
        }
        .onAppear { rows = pinned }
        // A thread pinned, unpinned or moved elsewhere lands here, but not
        // mid-save, where it would undo the drag being written.
        .onChange(of: pinned) { _, pinned in if !saving { rows = pinned } }
        .onChange(of: saving) { _, isSaving in if !isSaving { rows = pinned } }
    }

    private func move(_ id: String, offset: Int) {
        guard !saving, let index = rows.firstIndex(where: { $0.id == id }),
              rows.indices.contains(index + offset) else { return }
        rows.swapAt(index, index + offset)
        save(movedID: id)
    }

    private func save(movedID: String) {
        let writes = PinnedThreadOrder.assignments(
            ordered: rows,
            movedID: movedID,
            snapshot: model.snapshot.threads
        )
        guard !writes.isEmpty else { return }
        saving = true
        error = nil
        Task {
            for (id, key) in writes {
                if !(await model.setPinOrder(id, key: key)) {
                    error = "Couldn't save the new order. Try again."
                    PlatformHapticEngine.shared.play(.error)
                    break
                }
            }
            saving = false
        }
    }
}
