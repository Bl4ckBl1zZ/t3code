import SwiftUI

/// A model row that presents the full model list as a sheet. Settings screens
/// use it; the composer's task settings push the same list inside their own
/// navigation stack instead.
public struct ProviderModelPicker: View {
    let providers: [FeatureProvider]
    @Binding var selection: FeatureSelection?
    let isLoading: Bool
    let threadSelection: FeatureSelection?
    let materializesDefaultSelection: Bool
    let setupContext: ProviderSetupContext?

    @State private var isPresented = false

    public init(
        providers: [FeatureProvider],
        selection: Binding<FeatureSelection?>,
        isLoading: Bool = false,
        threadSelection: FeatureSelection? = nil,
        materializesDefaultSelection: Bool = true,
        setupContext: ProviderSetupContext? = nil
    ) {
        self.providers = providers
        _selection = selection
        self.isLoading = isLoading
        self.threadSelection = threadSelection
        self.materializesDefaultSelection = materializesDefaultSelection
        self.setupContext = setupContext
    }

    public var body: some View {
        Button {
            isPresented = true
        } label: {
            HStack(spacing: 12) {
                ProviderModelPickerRowLabel(
                    providers: providers,
                    selection: selection,
                    threadSelection: threadSelection,
                    materializesDefaultSelection: materializesDefaultSelection,
                    isLoading: isLoading
                )
                Image(systemName: "chevron.right")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textTertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Choose model")
        .sheet(isPresented: $isPresented) {
            NavigationStack {
                ModelPickerList(
                    providers: ProviderModelCatalogNormalizer.normalized(providers),
                    selection: $selection,
                    isLoading: isLoading,
                    threadSelection: threadSelection,
                    materializesDefaultSelection: materializesDefaultSelection,
                    setupContext: setupContext,
                    onPicked: { isPresented = false }
                )
                .t3SheetToolbar(.close)
                .t3NavigationChrome()
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .onAppear(perform: materializeSelection)
        .onChange(of: providers) { materializeSelection() }
        .onChange(of: selection) { materializeSelection() }
    }

    private func materializeSelection() {
        guard let resolved = ComposerModelSelectionMaterializer.resolved(
            selection: selection,
            providers: providers,
            threadSelection: threadSelection,
            materializesDefaultSelection: materializesDefaultSelection
        ) else {
            return
        }
        guard selection != resolved.value else { return }
        selection = resolved.value
    }
}

/// The model row's content: provider mark, "Model", and the selection with its
/// option summary. Shared by the settings row and the task-settings push.
struct ProviderModelPickerRowLabel: View {
    let providers: [FeatureProvider]
    let selection: FeatureSelection?
    let threadSelection: FeatureSelection?
    let materializesDefaultSelection: Bool
    var isLoading = false

    var body: some View {
        HStack(spacing: 12) {
            selectionMark
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text("Model")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                Text(selectionLabel)
                    .font(T3Typography.control)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Model")
        .accessibilityValue(selectionLabel)
    }

    private var normalizedProviders: [FeatureProvider] {
        ProviderModelCatalogNormalizer.normalized(providers)
    }

    private var resolvedSelection: FeatureSelection? {
        if materializesDefaultSelection {
            return ProviderModelSelectionResolver.materialized(selection, in: normalizedProviders)
        }
        return ThreadComposerModelSelectionPolicy.resolvedSelection(
            explicit: selection,
            inherited: threadSelection,
            providers: normalizedProviders
        )
    }

    private var selectedOption: DailyUXModelOption? {
        guard let resolvedSelection,
              let provider = normalizedProviders.first(where: { $0.id == resolvedSelection.providerID }),
              let model = provider.models.first(where: { $0.id == resolvedSelection.modelID }) else {
            return nil
        }
        return DailyUXModelOption(provider: provider, model: model)
    }

    private var selectionLabel: String {
        guard let selectedOption else {
            guard let value = selection ?? threadSelection else { return "Choose model" }
            let name = normalizedProviders.first(where: { $0.id == value.providerID })?.name ?? value.providerID
            return "\(name) · \(value.modelID) (\(isLoading ? "Loading" : "Unavailable"))"
        }
        let base = "\(selectedOption.provider.name) · \(selectedOption.model.name)"
        guard let resolvedSelection,
              let summary = DailyUXModelOptions.summary(
                for: selectedOption.model,
                selections: resolvedSelection.options
              ) else {
            return base
        }
        return "\(base) · \(summary)"
    }

    @ViewBuilder
    private var selectionMark: some View {
        if let provider = selectedOption?.provider {
            ProviderIcon(
                driver: provider.driver,
                providerID: provider.id,
                fallbackName: provider.name,
                size: 22
            )
        } else {
            Image(systemName: "cpu")
                .font(.body.weight(.semibold))
                .foregroundStyle(T3Colors.textSecondary)
        }
    }
}

/// Favorites and recents shared by the full model list and the composer's
/// model chip, which both read and write the same two lists.
enum ModelPickerMemory {
    static let favoritesKey = "swift-ios.model-picker.favorites"
    static let recentsKey = "swift-ios.model-picker.recents"

    static func ids(in storage: String) -> [String] {
        storage.split(separator: "\n").map(String.init)
    }

    /// Moves `id` to the front of the recents, keeping eight.
    static func recording(_ id: String, in storage: String) -> String {
        ([id] + ids(in: storage).filter { $0 != id })
            .prefix(8)
            .joined(separator: "\n")
    }

    static func toggling(_ id: String, in storage: String) -> String {
        var next = Set(ids(in: storage))
        if next.contains(id) {
            next.remove(id)
        } else {
            next.insert(id)
        }
        return next.sorted().joined(separator: "\n")
    }

    /// The selection a pick commits. Re-picking the model already selected
    /// keeps its options; any other model starts from the catalog defaults.
    static func selection(
        for option: DailyUXModelOption,
        current: FeatureSelection?
    ) -> FeatureSelection {
        let options: [FeatureModelOptionSelection]
        if option.model.options.isEmpty {
            options = []
        } else if current?.providerID == option.provider.id, current?.modelID == option.model.id {
            options = ProviderModelConfiguration.materializedOptions(
                for: option.model,
                preserving: current?.options ?? []
            )
        } else {
            options = DailyUXModelOptions.defaults(for: option.model)
        }
        return FeatureSelection(
            providerID: option.provider.id,
            modelID: option.model.id,
            options: options
        )
    }
}

/// The full model list: favorites, recents, one section per provider, legacy
/// models, and agent setup last. Pushed inside task settings, or wrapped in a
/// sheet by `ProviderModelPicker`.
struct ModelPickerList: View {
    let providers: [FeatureProvider]
    @Binding var selection: FeatureSelection?
    let isLoading: Bool
    let threadSelection: FeatureSelection?
    let materializesDefaultSelection: Bool
    let setupContext: ProviderSetupContext?
    /// Called after a pick is committed, to pop or dismiss.
    let onPicked: () -> Void

    @AppStorage(ModelPickerMemory.favoritesKey) private var favoriteStorage = ""
    @AppStorage(ModelPickerMemory.recentsKey) private var recentStorage = ""
    @State private var query = ""
    @State private var legacyModelsExpanded = false

    var body: some View {
        Group {
            if isLoading, availableModelCount == 0 {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Loading models")
                        .font(T3Typography.control)
                        .foregroundStyle(T3Colors.textSecondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if availableModelCount == 0 {
                ContentUnavailableView {
                    Label("No Models Available", systemImage: "cpu")
                } description: {
                    Text("Check the providers enabled on this environment.")
                } actions: {
                    if let setupContext {
                        NavigationLink {
                            ProviderSetupView(
                                context: setupContext,
                                instanceID: (selection ?? threadSelection)?.providerID
                            )
                        } label: {
                            Text("Set Up Agents")
                        }
                        .t3ProminentButtonStyle()
                    }
                }
            } else {
                modelList
            }
        }
        .navigationTitle("Model")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search models")
        .onAppear(perform: revealSelectedLegacyModel)
        .onChange(of: selection) { revealSelectedLegacyModel() }
        .onChange(of: providers) { revealSelectedLegacyModel() }
    }

    private var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var modelList: some View {
        List {
            if let unavailable = unavailableCurrentModel, !isSearching {
                Section {
                    ModelOptionLabel(
                        providerName: unavailable.providerName,
                        driver: unavailable.driver,
                        providerID: unavailable.providerID,
                        modelName: unavailable.modelName,
                        detail: unavailable.providerName,
                        badge: nil,
                        supportsImages: false,
                        isSelected: false,
                        isUnavailable: true
                    )
                    .t3SheetRow()
                } header: {
                    Text("Current Model")
                } footer: {
                    Text("\(unavailable.providerName) isn’t available right now. Pick another model to keep working.")
                }
            }

            if modelChangesAreLocked {
                Section {
                    EmptyView()
                } footer: {
                    Label("This provider fixes the model when a task starts.", systemImage: "lock")
                }
            }

            if !displaySections.favorites.isEmpty {
                Section("Favorites") {
                    ForEach(displaySections.favorites) { option in
                        modelRow(option)
                    }
                }
            }

            if !displaySections.recents.isEmpty {
                Section("Recent") {
                    ForEach(displaySections.recents) { option in
                        modelRow(option)
                    }
                }
            }

            ForEach(displaySections.currentProviderGroups, id: \.provider.id) { group in
                Section(group.provider.name) {
                    ForEach(group.models) { option in
                        modelRow(option)
                    }
                }
            }

            if !displaySections.legacy.isEmpty {
                if isSearching {
                    // Searching is looking for something specific: legacy
                    // matches read as a plain section, not a folded group.
                    Section("Legacy") {
                        ForEach(displaySections.legacy) { option in
                            modelRow(option)
                        }
                    }
                } else {
                    Section {
                        DisclosureGroup(isExpanded: $legacyModelsExpanded) {
                            ForEach(displaySections.legacy) { option in
                                modelRow(option)
                            }
                        } label: {
                            LabeledContent("Legacy Models") {
                                Text("\(displaySections.legacy.count)")
                                    .monospacedDigit()
                            }
                        }
                        .t3SheetRow()
                    }
                }
            }

            if catalog.all.isEmpty {
                ContentUnavailableView.search(text: query)
                    .listRowBackground(Color.clear)
            }

            if let setupContext, !isSearching {
                Section {
                    NavigationLink {
                        ProviderSetupView(context: setupContext, instanceID: nil)
                    } label: {
                        Label("Set Up Agents…", systemImage: "person.crop.circle.badge.plus")
                    }
                    .t3SheetRow()
                }
            }
        }
        .listStyle(.insetGrouped)
        .t3SheetListBackground()
    }

    private var availableModelCount: Int {
        providers
            .filter(\.isAvailable)
            .reduce(into: 0) { count, provider in
                count += provider.models.count
            }
    }

    private func modelRow(_ option: DailyUXModelOption) -> some View {
        let isFavorite = favoriteIDs.contains(option.id)
        return Button {
            select(option)
        } label: {
            ModelOptionLabel(
                option: option,
                isSelected: resolvedSelection?.providerID == option.provider.id
                    && resolvedSelection?.modelID == option.model.id
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isLocked(option))
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                toggleFavorite(option.id)
            } label: {
                Label(isFavorite ? "Unfavorite" : "Favorite", systemImage: isFavorite ? "star.slash" : "star")
            }
            .tint(T3Colors.warning)
        }
        .contextMenu {
            Button {
                toggleFavorite(option.id)
            } label: {
                Label(
                    isFavorite ? "Remove from Favorites" : "Add to Favorites",
                    systemImage: isFavorite ? "star.slash" : "star"
                )
            }
        }
        .t3SheetRow()
    }

    /// The model this composer is on when its provider has dropped out of the
    /// catalog (offline, signed out). Shown disabled at the top so the list
    /// still says what is selected instead of silently checking nothing.
    private var unavailableCurrentModel: (
        providerID: String,
        providerName: String,
        driver: String,
        modelName: String
    )? {
        guard let current = selection ?? threadSelection else { return nil }
        let provider = providers.first { $0.id == current.providerID }
        let isOffered = provider?.isAvailable == true
            && provider?.models.contains(where: { $0.id == current.modelID }) == true
        guard !isOffered else { return nil }
        return (
            current.providerID,
            provider?.name ?? current.providerID,
            provider?.driver ?? "",
            provider?.models.first { $0.id == current.modelID }?.name ?? current.modelID
        )
    }

    private var favoriteIDs: Set<String> {
        Set(ModelPickerMemory.ids(in: favoriteStorage))
    }

    private var recentIDs: [String] {
        ModelPickerMemory.ids(in: recentStorage)
    }

    private var catalog: DailyUXModelCatalog {
        DailyUXModelCatalog(
            providers: providers,
            query: query,
            favoriteIDs: favoriteIDs,
            recentIDs: recentIDs
        )
    }

    private var displaySections: ProviderModelDisplaySections {
        ProviderModelDisplaySections(catalog: catalog)
    }

    private var resolvedSelection: FeatureSelection? {
        if materializesDefaultSelection {
            return ProviderModelSelectionResolver.materialized(selection, in: providers)
        }
        return ThreadComposerModelSelectionPolicy.resolvedSelection(
            explicit: selection,
            inherited: threadSelection,
            providers: providers
        )
    }

    /// Tapping a model commits it immediately and pops back.
    private func select(_ option: DailyUXModelOption) {
        guard !isLocked(option) else { return }
        selection = ModelPickerMemory.selection(for: option, current: selection)
        recentStorage = ModelPickerMemory.recording(option.id, in: recentStorage)
        PlatformHapticEngine.shared.playSelection()
        onPicked()
    }

    private func revealSelectedLegacyModel() {
        guard !legacyModelsExpanded, let resolvedSelection else { return }
        if displaySections.legacy.contains(where: {
            $0.provider.id == resolvedSelection.providerID
                && $0.model.id == resolvedSelection.modelID
        }) {
            legacyModelsExpanded = true
        }
    }

    private var modelChangesAreLocked: Bool {
        guard let threadSelection,
              let provider = providers.first(where: { $0.id == threadSelection.providerID }) else {
            return false
        }
        return provider.requiresNewThreadForModelChange
    }

    private func isLocked(_ option: DailyUXModelOption) -> Bool {
        guard modelChangesAreLocked, let threadSelection else { return false }
        return option.provider.id != threadSelection.providerID
            || option.model.id != threadSelection.modelID
    }

    private func toggleFavorite(_ id: String) {
        favoriteStorage = ModelPickerMemory.toggling(id, in: favoriteStorage)
    }
}

/// Resolves the selection a composer should hold once its catalog arrives.
///
/// This used to live inside ``ProviderModelPicker``, which meant mounting the
/// picker was what materialized the default model. The composer now hides the
/// picker behind its task-settings sheet, so the rule has to be callable from
/// the composer itself — otherwise a thread would sit on a nil selection until
/// the user happened to open the sheet.
enum ComposerModelSelectionMaterializer {
    /// Wrapped so "resolved to nil" (a deliberate no-explicit-override) stays
    /// distinguishable from "nothing to do yet" (no catalog).
    struct Resolution: Equatable {
        let value: FeatureSelection?
    }

    static func resolved(
        selection: FeatureSelection?,
        providers: [FeatureProvider],
        threadSelection: FeatureSelection?,
        materializesDefaultSelection: Bool
    ) -> Resolution? {
        let normalized = ProviderModelCatalogNormalizer.normalized(providers)
        guard !normalized.isEmpty else { return nil }
        if materializesDefaultSelection {
            return Resolution(
                value: ProviderModelSelectionResolver.materialized(selection, in: normalized)
            )
        }
        return Resolution(
            value: ThreadComposerModelSelectionPolicy.explicitSelection(
                selection,
                inherited: threadSelection,
                providers: normalized
            )
        )
    }
}

/// The picker never represents an implicit "automatic" model. A missing or stale
/// selection becomes the environment's concrete preferred model as soon as the
/// catalog is available.
enum ProviderModelSelectionResolver {
    static func validated(
        _ selection: FeatureSelection?,
        in providers: [FeatureProvider]
    ) -> FeatureSelection? {
        guard !providers.isEmpty else { return selection }
        guard var validated = DailyUXModelOptions.validated(selection, in: providers),
              let model = providers
                  .first(where: { $0.id == validated.providerID })?
                  .models.first(where: { $0.id == validated.modelID }) else {
            return nil
        }
        validated.options = ProviderModelConfiguration.materializedOptions(
            for: model,
            preserving: validated.options
        )
        return validated
    }

    static func materialized(
        _ selection: FeatureSelection?,
        in providers: [FeatureProvider]
    ) -> FeatureSelection? {
        guard !providers.isEmpty else { return selection }
        if let validated = validated(selection, in: providers) {
            return validated
        }
        let currentProviders = providers.compactMap { provider -> FeatureProvider? in
            var current = provider
            current.models = provider.models.filter {
                ProviderModelFamilyClassifier.isCurrent($0, provider: provider)
            }
            return current.models.isEmpty ? nil : current
        }
        return DailyUXModelOptions.preferredSelection(in: currentProviders)
            ?? DailyUXModelOptions.preferredSelection(in: providers)
    }
}

/// Existing threads inherit their persisted model until the user deliberately
/// chooses an override. Unlike new-task composers, a missing selection must not
/// materialize the environment default and silently change providers.
enum ThreadComposerModelSelectionPolicy {
    static func resolvedSelection(
        explicit: FeatureSelection?,
        inherited: FeatureSelection?,
        providers: [FeatureProvider]
    ) -> FeatureSelection? {
        explicitSelection(explicit, inherited: inherited, providers: providers)
            ?? ProviderModelSelectionResolver.validated(inherited, in: providers)
    }

    static func explicitSelection(
        _ explicit: FeatureSelection?,
        inherited: FeatureSelection?,
        providers: [FeatureProvider]
    ) -> FeatureSelection? {
        guard let explicit, let inherited else { return nil }
        guard let validated = ProviderModelSelectionResolver.validated(explicit, in: providers)
        else {
            return nil
        }

        let inheritedProvider = providers.first { $0.id == inherited.providerID }
        if inheritedProvider?.requiresNewThreadForModelChange == true,
           (validated.providerID != inherited.providerID
               || validated.modelID != inherited.modelID) {
            return nil
        }
        return validated
    }
}

enum ProviderModelCatalogNormalizer {
    static func normalized(_ providers: [FeatureProvider]) -> [FeatureProvider] {
        var order: [String] = []
        var providersByID: [String: FeatureProvider] = [:]
        var modelIDsByProvider: [String: Set<String>] = [:]

        for provider in providers {
            let visibleModels = provider.models.filter { !isImplicitModel($0) }
            if var existing = providersByID[provider.id] {
                existing.isAvailable = existing.isAvailable || provider.isAvailable
                existing.requiresNewThreadForModelChange =
                    existing.requiresNewThreadForModelChange
                    || provider.requiresNewThreadForModelChange
                if existing.name.isEmpty {
                    existing.name = provider.name
                }
                if existing.driver.isEmpty {
                    existing.driver = provider.driver
                }
                existing.slashCommands = mergingMetadata(
                    existing.slashCommands,
                    provider.slashCommands,
                    id: \.id
                )
                existing.skills = mergingMetadata(
                    existing.skills,
                    provider.skills,
                    id: \.id
                )
                providersByID[provider.id] = existing
            } else {
                var normalized = provider
                normalized.models = []
                providersByID[provider.id] = normalized
                modelIDsByProvider[provider.id] = []
                order.append(provider.id)
            }

            for model in visibleModels {
                let wasInserted = modelIDsByProvider[provider.id, default: []]
                    .insert(model.id)
                    .inserted
                if wasInserted {
                    providersByID[provider.id]?.models.append(model)
                }
            }
        }

        return order.compactMap { providersByID[$0] }
    }

    private static func mergingMetadata<Value>(
        _ first: [Value]?,
        _ second: [Value]?,
        id: KeyPath<Value, String>
    ) -> [Value]? {
        guard first != nil || second != nil else { return nil }
        var seen = Set<String>()
        return ((first ?? []) + (second ?? [])).filter {
            seen.insert($0[keyPath: id]).inserted
        }
    }

    private static func isImplicitModel(_ model: FeatureModel) -> Bool {
        let tokens = [model.id, model.name].flatMap {
            $0.lowercased()
                .split { !$0.isLetter && !$0.isNumber }
                .map(String.init)
        }
        return tokens.contains("automatic") || tokens.contains("auto")
    }
}

struct ProviderModelDisplaySections {
    let favorites: [DailyUXModelOption]
    let recents: [DailyUXModelOption]
    let currentProviderGroups: [(
        provider: FeatureProvider,
        models: [DailyUXModelOption]
    )]
    let legacy: [DailyUXModelOption]

    init(catalog: DailyUXModelCatalog) {
        let currentIDs = Set(catalog.all.compactMap { option in
            ProviderModelFamilyClassifier.isCurrent(
                option.model,
                provider: option.provider
            ) ? option.id : nil
        })
        favorites = catalog.favorites.filter { currentIDs.contains($0.id) }
        recents = catalog.recents.filter { currentIDs.contains($0.id) }
        let promoted = Set((favorites + recents).map(\.id))
        currentProviderGroups = catalog.providerGroups.compactMap { group in
            let models = group.models.filter {
                currentIDs.contains($0.id) && !promoted.contains($0.id)
            }
            return models.isEmpty ? nil : (group.provider, models)
        }
        legacy = catalog.all.filter { !currentIDs.contains($0.id) }
    }
}

enum ProviderModelFamilyClassifier {
    static func isCurrent(_ model: FeatureModel, provider _: FeatureProvider) -> Bool {
        model.isLegacy != true
    }
}

enum ProviderModelConfiguration {
    static func materializedOptions(
        for model: FeatureModel,
        preserving selections: [FeatureModelOptionSelection]
    ) -> [FeatureModelOptionSelection] {
        let selectedIDs = Set(selections.map(\.id))
        return selections + DailyUXModelOptions.defaults(for: model).filter {
            !selectedIDs.contains($0.id)
        }
    }
}


private struct ModelOptionLabel: View {
    let providerName: String
    let driver: String
    let providerID: String
    let modelName: String
    let detail: String
    let badge: String?
    let supportsImages: Bool
    let isSelected: Bool
    var isUnavailable = false

    init(option: DailyUXModelOption, isSelected: Bool) {
        self.init(
            providerName: option.provider.name,
            driver: option.provider.driver,
            providerID: option.provider.id,
            modelName: option.model.name,
            detail: option.model.detail ?? option.model.id,
            badge: option.model.badge,
            supportsImages: option.model.supportsImages,
            isSelected: isSelected
        )
    }

    init(
        providerName: String,
        driver: String,
        providerID: String,
        modelName: String,
        detail: String,
        badge: String?,
        supportsImages: Bool,
        isSelected: Bool,
        isUnavailable: Bool = false
    ) {
        self.providerName = providerName
        self.driver = driver
        self.providerID = providerID
        self.modelName = modelName
        self.detail = detail
        self.badge = badge
        self.supportsImages = supportsImages
        self.isSelected = isSelected
        self.isUnavailable = isUnavailable
    }

    var body: some View {
        HStack(spacing: 12) {
            ProviderIcon(
                driver: driver,
                providerID: providerID,
                fallbackName: providerName,
                size: 26
            )
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 7) {
                    Text(modelName)
                        .font(T3Typography.homeTitle)
                        .foregroundStyle(isUnavailable ? T3Colors.textSecondary : T3Colors.textPrimary)
                        .lineLimit(1)
                    if badge == "new" {
                        Text("NEW")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(T3Colors.accent)
                            .accessibilityLabel("New model")
                    }
                    if isUnavailable {
                        Text("Unavailable")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(T3Colors.textSecondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(T3Colors.subtleStrong, in: Capsule())
                    }
                    if supportsImages {
                        Label("Images", systemImage: "photo")
                            .labelStyle(.iconOnly)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                            .accessibilityLabel("Accepts images")
                    }
                }
                Text(detail)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            if isSelected {
                Image(systemName: "checkmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(T3Colors.accent)
                    .accessibilityLabel("Selected")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
