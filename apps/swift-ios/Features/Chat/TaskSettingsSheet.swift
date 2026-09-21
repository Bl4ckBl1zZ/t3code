import SwiftUI

/// The screen the task-settings sheet opens on. The composer's model chip
/// opens the sheet straight onto the model list ("All Models…") or agent setup
/// ("Set Up Agents…") as well as onto the settings list itself.
enum TaskSettingsEntry: Hashable, Identifiable {
    case settings
    case models
    case setup

    var id: Self { self }
}

/// The composer's task settings, nested in a bottom sheet.
///
/// Swift counterpart of upstream's `ThreadSettingsSheet` restructure: the model
/// and every option the model publishes live behind one trigger instead of
/// competing for room in the composer footer, where a long model name used to
/// squeeze the chips out of the row.
///
/// The model list and long option lists push inside the sheet's own
/// navigation stack rather than opening a second sheet on top of the first.
/// Stacked detent sheets fight each other for the drag gesture on iOS, and a
/// push keeps the back-swipe the user already expects from every other list.
struct TaskSettingsSheet: View {
    private enum Route: Hashable {
        case models
        case setup
    }

    @Binding var selection: FeatureSelection?
    let providers: [FeatureProvider]
    let threadSelection: FeatureSelection?
    let materializesDefaultSelection: Bool
    var setupContext: ProviderSetupContext? = nil

    @State private var path: [Route]

    init(
        selection: Binding<FeatureSelection?>,
        providers: [FeatureProvider],
        threadSelection: FeatureSelection?,
        materializesDefaultSelection: Bool,
        setupContext: ProviderSetupContext? = nil,
        entry: TaskSettingsEntry = .settings
    ) {
        _selection = selection
        self.providers = providers
        self.threadSelection = threadSelection
        self.materializesDefaultSelection = materializesDefaultSelection
        self.setupContext = setupContext
        let initialPath: [Route] = switch entry {
        case .settings: []
        case .models: [.models]
        case .setup: setupContext == nil ? [.models] : [.setup]
        }
        _path = State(initialValue: initialPath)
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    NavigationLink(value: Route.models) {
                        ProviderModelPickerRowLabel(
                            providers: providers,
                            selection: selection,
                            threadSelection: threadSelection,
                            materializesDefaultSelection: materializesDefaultSelection
                        )
                    }
                    .accessibilityLabel("Model")
                    .t3SheetRow()
                }

                if !rows.isEmpty {
                    Section {
                        ForEach(rows) { row in
                            optionRow(row)
                                .t3SheetRow()
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .t3SheetListBackground()
            .navigationTitle("Task Settings")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .models:
                    ModelPickerList(
                        providers: ProviderModelCatalogNormalizer.normalized(providers),
                        selection: $selection,
                        isLoading: false,
                        threadSelection: threadSelection,
                        materializesDefaultSelection: materializesDefaultSelection,
                        setupContext: setupContext,
                        onPicked: popModelPicker
                    )
                case .setup:
                    if let setupContext {
                        ProviderSetupView(context: setupContext, instanceID: nil)
                    }
                }
            }
            .t3SheetToolbar(.close)
            .t3NavigationChrome()
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    /// Picking a model pops back to the settings list, unless the sheet was
    /// opened straight onto the model list; then there is nothing to pop to.
    private func popModelPicker() {
        if path.count > 1 || path.first != .models {
            path.removeLast()
        } else {
            path = []
        }
    }

    @ViewBuilder
    private func optionRow(_ row: TaskSettingsRow) -> some View {
        switch row.descriptor.kind {
        case .select:
            let picker = Picker(
                selection: Binding(
                    get: { row.selectedChoiceID ?? "" },
                    set: { setOption(id: row.descriptor.id, value: .string($0)) }
                )
            ) {
                ForEach(row.descriptor.choices) { choice in
                    choiceLabel(choice)
                        .tag(choice.id)
                }
            } label: {
                Text(row.descriptor.label)
                    .font(T3Typography.control)
            }
            // A handful of bare choices reads best as an inline menu; longer
            // lists, or choices that carry an explanation, get their own page.
            if TaskSettingsOptions.prefersInlinePicker(row.descriptor) {
                picker.pickerStyle(.menu)
            } else {
                picker.pickerStyle(.navigationLink)
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

    private func choiceLabel(_ choice: FeatureModelOptionChoice) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(choice.label)
            if let detail = choice.detail {
                Text(detail)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
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

    private func setOption(id: String, value: FeatureModelOptionValue) {
        guard let next = TaskSettingsOptions.selection(activeSelection, setting: id, to: value) else {
            return
        }
        selection = next
    }
}
