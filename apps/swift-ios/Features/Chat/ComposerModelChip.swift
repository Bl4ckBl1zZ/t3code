import SwiftUI

/// The composer's model chip: the current model's name, opening a menu for
/// quick switching, the model's own options, and the full task settings.
///
/// A real menu rather than a sheet trigger: the everyday change (a different
/// favorite, a different effort) is one tap from the composer, and only the
/// rarer ones ("All Models…", "More Settings…") open the task-settings sheet.
struct ComposerModelChip: View {
    @Binding var selection: FeatureSelection?
    let providers: [FeatureProvider]
    let threadSelection: FeatureSelection?
    let canSetUpAgents: Bool
    let onOpen: (TaskSettingsEntry) -> Void

    @AppStorage(ModelPickerMemory.favoritesKey) private var favoriteStorage = ""
    @AppStorage(ModelPickerMemory.recentsKey) private var recentStorage = ""

    var body: some View {
        // Resolved once per render: the chip re-renders with the composer on
        // every keystroke, so the catalog is walked here and nowhere else.
        let resolved = ResolvedModel(
            providers: providers,
            active: selection ?? threadSelection,
            threadSelection: threadSelection
        )
        Menu {
            menuContent(resolved)
        } label: {
            chipLabel(resolved)
        }
        .menuOrder(.fixed)
        .accessibilityLabel("Model")
        .accessibilityValue(accessibilityValue(resolved))
        .accessibilityIdentifier("composer-model-chip")
    }

    // MARK: - Label

    private func chipLabel(_ resolved: ResolvedModel) -> some View {
        HStack(spacing: 5) {
            if let provider = resolved.provider {
                ProviderIcon(
                    driver: provider.driver,
                    providerID: provider.id,
                    fallbackName: provider.name,
                    size: 14
                )
            } else {
                Image(systemName: "cpu")
                    .imageScale(.small)
            }
            Text(resolved.model?.name ?? resolved.active?.modelID ?? "Choose Model")
                .lineLimit(1)
                .truncationMode(.tail)
            if resolved.isUnavailable {
                Image(systemName: "exclamationmark.triangle.fill")
                    .imageScale(.small)
                    .foregroundStyle(T3Colors.warning)
                    .accessibilityHidden(true)
            }
            Image(systemName: "chevron.down")
                .font(.caption2.weight(.bold))
                .accessibilityHidden(true)
        }
        .font(T3Typography.supportingStrong)
        .foregroundStyle(T3Colors.textSecondary)
        .padding(.horizontal, 6)
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .contentShape(Rectangle())
    }

    private func accessibilityValue(_ resolved: ResolvedModel) -> String {
        let summary = TaskSettingsOptions.summary(
            modelName: resolved.model?.name,
            model: resolved.model,
            selections: resolved.active?.options ?? []
        )
        return resolved.isUnavailable ? "\(summary), unavailable" : summary
    }

    // MARK: - Menu

    @ViewBuilder
    private func menuContent(_ resolved: ResolvedModel) -> some View {
        if resolved.available.isEmpty {
            if canSetUpAgents {
                Button("Set Up Agents…", systemImage: "person.crop.circle.badge.plus") {
                    onOpen(.setup)
                }
            } else {
                Text("No models are available on this computer.")
            }
        } else {
            if resolved.isUnavailable, let provider = resolved.provider {
                Text("\(provider.name) isn’t available right now. Pick another model.")
            }
            if resolved.isLocked {
                Text("This provider fixes the model when a task starts.")
            }

            Picker("Model", selection: quickPickBinding(resolved)) {
                ForEach(quickOptions(resolved)) { option in
                    Text(option.model.name)
                        .tag(option.id)
                }
            }
            .pickerStyle(.inline)

            let rows = resolved.isUnavailable
                ? []
                : TaskSettingsOptions.rows(for: resolved.model, selections: resolved.active?.options ?? [])
            if !rows.isEmpty {
                Section {
                    ForEach(rows) { row in
                        optionControl(row, active: resolved.active)
                    }
                }
            }

            Section {
                if !resolved.isLocked {
                    Button("All Models…", systemImage: "cpu") { onOpen(.models) }
                }
                Button("More Settings…", systemImage: "slider.horizontal.3") { onOpen(.settings) }
            }
        }
    }

    @ViewBuilder
    private func optionControl(_ row: TaskSettingsRow, active: FeatureSelection?) -> some View {
        switch row.descriptor.kind {
        case .select:
            Picker(
                selection: Binding(
                    get: { row.selectedChoiceID ?? "" },
                    set: { setOption(row.descriptor.id, to: .string($0), on: active) }
                )
            ) {
                ForEach(row.descriptor.choices) { choice in
                    Text(choice.label).tag(choice.id)
                }
            } label: {
                Text(row.descriptor.label)
                Text(row.valueLabel)
            }
            .pickerStyle(.menu)
        case .boolean:
            Toggle(
                row.descriptor.label,
                isOn: Binding(
                    get: { row.isEnabled },
                    set: { setOption(row.descriptor.id, to: .boolean($0), on: active) }
                )
            )
        }
    }

    // MARK: - Quick switch

    /// Favorites, then recents, then the current model — six at most. With
    /// nothing remembered yet it falls back to the current provider's models so
    /// the menu still offers a real switch. A provider that fixes its model
    /// offers only that model.
    private func quickOptions(_ resolved: ResolvedModel) -> [DailyUXModelOption] {
        let byID = Dictionary(resolved.available.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let currentID = resolved.active.map {
            DailyUXModelOption.key(providerID: $0.providerID, modelID: $0.modelID)
        }
        if resolved.isLocked {
            return currentID.flatMap { byID[$0] }.map { [$0] } ?? []
        }
        var ids = ModelPickerMemory.ids(in: favoriteStorage) + ModelPickerMemory.ids(in: recentStorage)
        if let currentID { ids.append(currentID) }
        var seen = Set<String>()
        var options = ids.compactMap { id -> DailyUXModelOption? in
            guard seen.insert(id).inserted else { return nil }
            return byID[id]
        }
        if options.count < 2,
           let providerID = resolved.provider?.id ?? resolved.available.first?.provider.id {
            for option in resolved.available
            where option.provider.id == providerID && seen.insert(option.id).inserted {
                options.append(option)
            }
        }
        return Array(options.prefix(6))
    }

    private func quickPickBinding(_ resolved: ResolvedModel) -> Binding<String> {
        Binding(
            get: {
                resolved.active.map {
                    DailyUXModelOption.key(providerID: $0.providerID, modelID: $0.modelID)
                } ?? ""
            },
            set: { id in
                guard let option = resolved.available.first(where: { $0.id == id }) else { return }
                selection = ModelPickerMemory.selection(for: option, current: selection)
                recentStorage = ModelPickerMemory.recording(option.id, in: recentStorage)
            }
        )
    }

    private func setOption(_ id: String, to value: FeatureModelOptionValue, on active: FeatureSelection?) {
        guard let next = TaskSettingsOptions.selection(active, setting: id, to: value) else { return }
        selection = next
    }
}

/// The catalog as the chip needs it, resolved in one pass.
private struct ResolvedModel {
    let active: FeatureSelection?
    let provider: FeatureProvider?
    let model: FeatureModel?
    /// Every model the environment can run right now.
    let available: [DailyUXModelOption]
    /// The thread's provider fixes the model for the life of the thread.
    let isLocked: Bool

    init(providers: [FeatureProvider], active: FeatureSelection?, threadSelection: FeatureSelection?) {
        let normalized = ProviderModelCatalogNormalizer.normalized(providers)
        let activeProvider = active.flatMap { active in normalized.first { $0.id == active.providerID } }
        self.active = active
        provider = activeProvider
        model = active.flatMap { active in activeProvider?.models.first { $0.id == active.modelID } }
        available = normalized.filter(\.isAvailable).flatMap { provider in
            provider.models.map { DailyUXModelOption(provider: provider, model: $0) }
        }
        isLocked = threadSelection.flatMap { thread in
            normalized.first { $0.id == thread.providerID }?.requiresNewThreadForModelChange
        } ?? false
    }

    /// A model is chosen, but its provider cannot run it right now.
    var isUnavailable: Bool {
        active != nil && (provider?.isAvailable != true || model == nil)
    }
}
