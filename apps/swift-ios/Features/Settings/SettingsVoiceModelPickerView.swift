import SwiftUI

// Ported from apps/mobile/src/features/settings/SettingsVoiceModelRouteScreen.tsx.
//
// The transcription model gets its own screen because the OpenRouter audio
// catalog runs to dozens of entries: it needs a search field and a virtualized
// list, neither of which belongs inside the Voice Input screen's scroll view.

public struct SettingsVoiceModelPickerView: View {
    private let manager: any FeatureVoiceSettingsManaging
    private let onSelected: () -> Void

    /// `nil` while the catalog is still loading, which is what separates "no
    /// audio models on this account" from "not asked yet".
    @State private var models: [OpenRouterModelOption]?
    @State private var selected: String?
    @State private var query = ""
    @State private var customModel = ""
    @State private var errorMessage: String?
    @State private var isSaving = false

    public init(
        manager: any FeatureVoiceSettingsManaging,
        onSelected: @escaping () -> Void = {}
    ) {
        self.manager = manager
        self.onSelected = onSelected
    }

    private var filtered: [OpenRouterModelOption] {
        VoiceModelCatalog.filter(models ?? [], query: query)
    }

    private var trimmedCustomModel: String {
        customModel.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var body: some View {
        List {
            if let errorMessage {
                Section {
                    SettingsErrorBanner(message: errorMessage)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
            }

            catalogSection
            customModelSection
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .background(T3Colors.background)
        .navigationTitle("Model")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(
            text: $query,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Search models"
        )
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .task { await load() }
    }

    @ViewBuilder
    private var catalogSection: some View {
        if models == nil {
            Section {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
                    .listRowBackground(Color.clear)
                    .accessibilityLabel("Loading models")
            }
        } else if filtered.isEmpty {
            Section {
                Text(
                    query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? "No audio models are available on this OpenRouter account."
                        : "No models match that search."
                )
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 12)
                .listRowBackground(Color.clear)
            }
        } else {
            Section("AUDIO MODELS") {
                ForEach(filtered) { model in
                    Button {
                        Task { await save(model.id) }
                    } label: {
                        modelRow(model)
                    }
                    .buttonStyle(.plain)
                    .disabled(isSaving)
                    .listRowBackground(Color.clear)
                }
            }
        }
    }

    private var customModelSection: some View {
        Section("CUSTOM MODEL ID") {
            VStack(alignment: .leading, spacing: 12) {
                TextField("provider/model-id", text: $customModel)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .settingsInputField()
                    .accessibilityLabel("Custom model ID")

                SettingsActionButton(
                    title: "Use custom model",
                    systemImage: "checkmark",
                    tone: .primary,
                    isBusy: isSaving,
                    isDisabled: trimmedCustomModel.isEmpty
                        || trimmedCustomModel == (selected ?? "")
                ) {
                    Task { await save(trimmedCustomModel) }
                }
                .padding(.horizontal, SettingsMetrics.rowPadding)

                SettingsFootnote(
                    """
                    Any OpenRouter model that accepts audio input works here. The default is \
                    \(VoiceInputSettings.defaultModel).
                    """
                )
            }
            .padding(.vertical, 8)
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
    }

    private func modelRow(_ model: OpenRouterModelOption) -> some View {
        let isSelected = model.id == selected
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(model.name)
                    .font(T3Typography.homeTitle)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                Text(model.subtitle)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if isSelected {
                Image(systemName: "checkmark")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.accent)
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }

    @MainActor
    private func load() async {
        do {
            let settings = try await manager.voiceInputSettings()
            selected = settings.model
            let catalog = try await manager.listOpenRouterAudioModels()
            models = catalog
            // A model the catalog does not list was set from somewhere else, so
            // it seeds the custom field rather than vanishing from the screen.
            if !catalog.contains(where: { $0.id == settings.model }) {
                customModel = settings.model
            }
        } catch {
            models = []
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func save(_ model: String) async {
        guard !model.isEmpty else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            selected = try await manager.patchVoiceInputSettings(.init(model: model)).model
            onSelected()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
