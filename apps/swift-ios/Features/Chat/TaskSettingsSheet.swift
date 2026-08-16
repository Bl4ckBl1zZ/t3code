import SwiftUI

/// The composer's task settings, nested in a bottom sheet.
///
/// Swift counterpart of upstream's `ThreadSettingsSheet` restructure: the model
/// and every option the model publishes live behind one trigger instead of
/// competing for room in the composer footer, where a long model name used to
/// squeeze the chips out of the row.
///
/// Options push inside the sheet's own navigation stack rather than opening a
/// second sheet on top of the first. Stacked detent sheets fight each other for
/// the drag gesture on iOS, and a push keeps the back-swipe the user already
/// expects from every other list here.
struct TaskSettingsSheet: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss

    @Binding var selection: FeatureSelection?
    let providers: [FeatureProvider]
    let threadSelection: FeatureSelection?
    let materializesDefaultSelection: Bool

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ProviderModelPicker(
                        providers: providers,
                        selection: $selection,
                        style: .row,
                        threadSelection: threadSelection,
                        materializesDefaultSelection: materializesDefaultSelection
                    )
                    .listRowBackground(T3Colors.surface)
                }

                if !rows.isEmpty {
                    Section("Model options") {
                        ForEach(rows) { row in
                            optionRow(row)
                                .listRowBackground(T3Colors.surface)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(T3Colors.background)
            .navigationTitle("Task settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .t3NavigationChrome()
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private func optionRow(_ row: TaskSettingsRow) -> some View {
        switch row.descriptor.kind {
        case .select:
            NavigationLink {
                TaskSettingsChoiceList(
                    descriptor: row.descriptor,
                    selectedChoiceID: row.selectedChoiceID,
                    onSelect: { choiceID in
                        setOption(id: row.descriptor.id, value: .string(choiceID))
                    }
                )
            } label: {
                LabeledContent(row.descriptor.label) {
                    Text(row.valueLabel)
                        .foregroundStyle(T3Colors.textSecondary)
                }
                .font(T3Typography.control)
            }
        case .boolean:
            Toggle(
                isOn: Binding(
                    get: { row.isEnabled },
                    set: { setOption(id: row.descriptor.id, value: .boolean($0)) }
                )
            ) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.descriptor.label)
                        .font(T3Typography.control)
                    if let detail = row.descriptor.detail {
                        Text(detail)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                }
            }
        }
    }

    private var activeSelection: FeatureSelection? { selection ?? threadSelection }

    private var activeModel: FeatureModel? {
        guard let active = activeSelection,
              let provider = providers.first(where: { $0.id == active.providerID }) else {
            return nil
        }
        return provider.models.first { $0.id == active.modelID }
    }

    private var rows: [TaskSettingsRow] {
        TaskSettingsOptions.rows(
            for: activeModel,
            selections: activeSelection?.options ?? []
        )
    }

    /// Writes onto the active selection, materializing the inherited one first:
    /// changing an option on a thread whose model was never overridden must not
    /// silently drop the model it inherited.
    private func setOption(id: String, value: FeatureModelOptionValue) {
        guard var next = activeSelection else { return }
        next.options = DailyUXModelOptions.updating(next.options, id: id, value: value)
        selection = next
    }
}

private struct TaskSettingsChoiceList: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss

    let descriptor: FeatureModelOptionDescriptor
    let selectedChoiceID: String?
    let onSelect: (String) -> Void

    var body: some View {
        List {
            ForEach(descriptor.choices) { choice in
                Button {
                    onSelect(choice.id)
                    dismiss()
                } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(choice.label)
                                .font(T3Typography.control)
                                .foregroundStyle(T3Colors.textPrimary)
                            if let detail = choice.detail {
                                Text(detail)
                                    .font(T3Typography.supporting)
                                    .foregroundStyle(T3Colors.textSecondary)
                            }
                        }
                        Spacer(minLength: 6)
                        if choice.id == selectedChoiceID {
                            Image(systemName: "checkmark")
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(T3Colors.textPrimary)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowBackground(T3Colors.surface)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
        .navigationTitle(descriptor.label)
        .navigationBarTitleDisplayMode(.inline)
    }
}
