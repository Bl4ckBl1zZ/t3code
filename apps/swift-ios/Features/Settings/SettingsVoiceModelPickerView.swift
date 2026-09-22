import SwiftUI

// Ported from apps/mobile/src/features/settings/SettingsVoiceModelRouteScreen.tsx.
//
// The transcription model gets its own screen because the OpenRouter audio
// catalog runs to dozens of entries: it needs a search field, which does not
// belong inside the Voice Input screen. Pushed from Voice Input; choosing a
// model saves it and pops back.

public struct SettingsVoiceModelPickerView: View {
    private let manager: any FeatureVoiceSettingsManaging
    private let onSelected: () -> Void

    @SwiftUI.Environment(\.dismiss) private var dismiss
    /// `nil` while the catalog is still loading, which is what separates "no
    /// audio models on this account" from "not asked yet".
    @State private var models: [OpenRouterModelOption]?
    @State private var selected: String?
    @State private var query = ""
    @State private var customModel = ""
    @State private var loadError: String?
    @State private var saveError: String?
    @State private var savingID: String?

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

    private var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var trimmedCustomModel: String {
        customModel.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var body: some View {
        content
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .t3Searchable(
                text: $query,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: Text("Search Models")
            )
            .task { await load() }
    }

    @ViewBuilder
    private var content: some View {
        if let loadError, models == nil {
            ContentUnavailableView {
                Label("Couldn't Load Models", systemImage: "exclamationmark.triangle")
            } description: {
                Text(loadError)
            } actions: {
                Button("Try Again") { Task { await load() } }
            }
            .background(T3Colors.background)
        } else if models?.isEmpty == true, !isSearching, selected.map({ $0.isEmpty }) ?? true {
            ContentUnavailableView(
                "No Audio Models",
                systemImage: "waveform.slash",
                description: Text("No audio models are available on this OpenRouter account.")
            )
            .background(T3Colors.background)
        } else {
            SettingsForm {
                if models == nil {
                    Section { SettingsPlaceholderRows(count: 4) }
                } else if !filtered.isEmpty {
                    Section {
                        ForEach(filtered) { model in
                            Button {
                                Task { await save(model.id) }
                            } label: {
                                modelRow(model)
                            }
                            .disabled(savingID != nil)
                        }
                    } footer: {
                        if let saveError { Text(saveError).foregroundStyle(T3Colors.danger) }
                    }
                }
                if !isSearching {
                    customSection
                }
            }
            .overlay {
                if isSearching, models != nil, filtered.isEmpty {
                    ContentUnavailableView.search(text: query)
                }
            }
        }
    }

    /// A model the catalog does not list — set here or on another client —
    /// shows as its ID with the checkmark.
    private var customSection: some View {
        Section {
            if let selected, let models, !selected.isEmpty, !models.contains(where: { $0.id == selected }) {
                HStack {
                    Text(selected).font(.system(.body, design: .monospaced))
                    Spacer()
                    Image(systemName: "checkmark").foregroundStyle(T3Colors.accent)
                }
                .accessibilityAddTraits(.isSelected)
            }
            HStack {
                TextField("provider/model-id", text: $customModel)
                    .font(.system(.body, design: .monospaced))
                    .submitLabel(.done)
                    .onSubmit { Task { await save(trimmedCustomModel) } }
                    .accessibilityLabel("Custom model ID")
                if savingID == trimmedCustomModel, !trimmedCustomModel.isEmpty {
                    ProgressView()
                }
            }
        } header: {
            Text("Other Model")
        } footer: {
            Text("Any OpenRouter model that accepts audio input. Press Return to use it. The default is \(VoiceInputSettings.defaultModel).")
        }
    }

    private func modelRow(_ model: OpenRouterModelOption) -> some View {
        let isSelected = model.id == selected
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.name)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                Text(model.subtitle)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if savingID == model.id {
                ProgressView()
            } else if isSelected {
                Image(systemName: "checkmark")
                    .fontWeight(.semibold)
                    .foregroundStyle(T3Colors.accent)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }

    @MainActor
    private func load() async {
        loadError = nil
        do {
            let settings = try await manager.voiceInputSettings()
            selected = settings.model
            models = try await manager.listOpenRouterAudioModels()
        } catch {
            loadError = error.localizedDescription
        }
    }

    @MainActor
    private func save(_ model: String) async {
        guard !model.isEmpty, savingID == nil else { return }
        guard model != selected else {
            dismiss()
            return
        }
        savingID = model
        saveError = nil
        defer { savingID = nil }
        do {
            selected = try await manager.patchVoiceInputSettings(.init(model: model)).model
            PlatformHapticEngine.shared.playSelection()
            onSelected()
            dismiss()
        } catch {
            PlatformHapticEngine.shared.play(.error)
            saveError = "Couldn't change the model. \(error.localizedDescription)"
        }
    }
}
