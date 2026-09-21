import SwiftUI

// Ported from apps/mobile/src/features/settings/SettingsVoiceInputRouteScreen.tsx.
//
// Every control writes through immediately as a partial patch rather than
// collecting into a Save button, matching React Native: the settings live on the
// account, so two devices editing different fields must not clobber each other.

public struct SettingsVoiceInputView: View {
    private let manager: any FeatureVoiceSettingsManaging

    @State private var status: OpenRouterIntegrationStatus?
    @State private var settings: VoiceInputSettings?
    @State private var audioModels: [OpenRouterModelOption] = []
    @State private var isLoaded = false
    @State private var loadError: String?
    @State private var saveError: String?
    @State private var newWord = ""

    public init(manager: any FeatureVoiceSettingsManaging) {
        self.manager = manager
    }

    /// Every control below OpenRouter needs a working credential. Preferences
    /// stay visible but disabled so a disconnected account can still see what
    /// it had configured.
    private var isConnected: Bool {
        status?.isConnected == true && settings != nil
    }

    public var body: some View {
        SettingsForm {
            integrationSection
            if isLoaded {
                transcriptionSection
                dictionarySection
            } else {
                Section { SettingsPlaceholderRows(count: 3) }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Voice Input")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .refreshable { await reload() }
    }

    private var integrationSection: some View {
        Section {
            NavigationLink {
                SettingsOpenRouterView(manager: manager) { latest in
                    status = latest
                    Task { await reload() }
                }
            } label: {
                LabeledContent {
                    Text(isConnected ? "Connected" : "Not Connected")
                        .redacted(reason: isLoaded ? [] : .placeholder)
                } label: {
                    SettingsTileLabel(title: "OpenRouter", systemImage: "waveform", tint: .indigo)
                }
            }
        } footer: {
            if let loadError {
                Text(loadError).foregroundStyle(T3Colors.danger)
            } else if isLoaded, !isConnected {
                Text("Connect OpenRouter to enable these controls. Saved preferences are preserved.")
            }
        }
    }

    private var transcriptionSection: some View {
        Section {
            Toggle("Improve Transcripts", isOn: Binding(
                get: { settings?.cleanupEnabled ?? true },
                set: { enabled in
                    Task { await patch(.init(cleanupEnabled: enabled)) { $0.cleanupEnabled = enabled } }
                }
            ))
            NavigationLink {
                SettingsVoiceModelPickerView(manager: manager) {
                    Task { await reload() }
                }
            } label: {
                LabeledContent("Model", value: selectedModelName)
            }
            NavigationLink {
                VoiceLanguageList(selection: settings?.language) { code in
                    let language: VoiceInputSettingsPatch.Language
                    if let code { language = .explicit(code) } else { language = .automatic }
                    Task { await patch(.init(language: language)) { $0.language = code } }
                }
            } label: {
                LabeledContent("Spoken Language", value: VoiceLanguageList.name(for: settings?.language))
            }
        } header: {
            Text("Transcription")
        } footer: {
            SettingsFooter(
                text: "Improve Transcripts fixes punctuation and filler words after transcription.",
                error: saveError
            )
        }
        .disabled(!isConnected)
    }

    private var dictionarySection: some View {
        let words = settings?.dictionary ?? []
        return Section {
            ForEach(words, id: \.self) { word in
                Text(word)
            }
            .onDelete { offsets in
                var next = words
                next.remove(atOffsets: offsets)
                Task { await patch(.init(dictionary: next)) { $0.dictionary = next } }
            }
            if words.count < VoiceInputSettings.maximumDictionaryEntries {
                TextField("Add Word", text: $newWord)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit(addWord)
            }
        } header: {
            Text("Personal Dictionary")
        } footer: {
            Text("""
            \(words.count) of \(VoiceInputSettings.maximumDictionaryEntries) words. Preferred \
            spellings for names and terms. Project and chat content are never added automatically.
            """)
        }
        .disabled(!isConnected)
    }

    private var selectedModelName: String {
        VoiceModelCatalog.displayName(
            for: settings?.model ?? VoiceInputSettings.defaultModel,
            in: audioModels
        )
    }

    private func addWord() {
        let word = String(newWord.trimmingCharacters(in: .whitespacesAndNewlines)
            .prefix(VoiceInputSettings.maximumDictionaryEntryLength))
        let words = settings?.dictionary ?? []
        newWord = ""
        guard !word.isEmpty, !words.contains(word) else { return }
        let next = VoiceInputDictionary.entries(from: VoiceInputDictionary.text(for: words + [word]))
        Task { await patch(.init(dictionary: next)) { $0.dictionary = next } }
    }

    @MainActor
    private func reload() async {
        do {
            let status = try await manager.openRouterIntegration()
            let settings = try await manager.voiceInputSettings()
            loadError = nil
            self.status = status
            self.settings = settings
            isLoaded = true
            guard status.isConnected else {
                audioModels = []
                return
            }
            // A catalog failure only costs the model row its friendly name, so
            // it must not take the whole screen down with it.
            audioModels = (try? await manager.listOpenRouterAudioModels()) ?? []
        } catch {
            isLoaded = true
            loadError = error.localizedDescription
        }
    }

    /// Shows the change at once, then settles on the server's answer. A failed
    /// write puts the row back and says why under the section.
    @MainActor
    private func patch(
        _ patch: VoiceInputSettingsPatch,
        optimistic apply: (inout VoiceInputSettings) -> Void
    ) async {
        guard var optimistic = settings else { return }
        let previous = optimistic
        apply(&optimistic)
        settings = optimistic
        saveError = nil
        do {
            settings = try await manager.patchVoiceInputSettings(patch)
        } catch {
            settings = previous
            PlatformHapticEngine.shared.play(.error)
            saveError = "Couldn't save. \(error.localizedDescription)"
        }
    }
}

/// The spoken language as a searchable list, Automatic first. Choosing one
/// saves it and pops back.
private struct VoiceLanguageList: View {
    let selection: String?
    let onSelect: (String?) -> Void
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private struct Language: Identifiable {
        let code: String
        let name: String
        var id: String { code }
    }

    private static let languages: [Language] = Locale.LanguageCode.isoLanguageCodes
        .map(\.identifier)
        .filter { $0.count == 2 }
        .compactMap { code in
            Locale.current.localizedString(forLanguageCode: code).map { Language(code: code, name: $0) }
        }
        .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }

    static func name(for code: String?) -> String {
        guard let code, !code.isEmpty else { return "Automatic" }
        return Locale.current.localizedString(forLanguageCode: code) ?? code
    }

    private var choices: [Language] {
        var all = Self.languages
        // A code set elsewhere that this list does not know still shows, checked.
        if let selection, !selection.isEmpty, !all.contains(where: { $0.code == selection }) {
            all.insert(Language(code: selection, name: Self.name(for: selection)), at: 0)
        }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return all }
        return all.filter {
            $0.name.localizedCaseInsensitiveContains(needle) || $0.code.localizedCaseInsensitiveContains(needle)
        }
    }

    var body: some View {
        SettingsForm {
            if query.isEmpty {
                Section {
                    row(title: "Automatic", code: nil)
                } footer: {
                    Text("Detects the language from what you say.")
                }
            }
            Section {
                ForEach(choices) { language in
                    row(title: language.name, code: language.code)
                }
            }
        }
        .overlay {
            if !query.isEmpty, choices.isEmpty {
                ContentUnavailableView.search(text: query)
            }
        }
        .navigationTitle("Spoken Language")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search Languages")
    }

    private func row(title: String, code: String?) -> some View {
        let isSelected = (selection?.isEmpty == false ? selection : nil) == code
        return Button {
            if !isSelected { onSelect(code) }
            PlatformHapticEngine.shared.playSelection()
            dismiss()
        } label: {
            HStack {
                Text(title).foregroundStyle(T3Colors.textPrimary)
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark")
                        .fontWeight(.semibold)
                        .foregroundStyle(T3Colors.accent)
                }
            }
            .contentShape(Rectangle())
        }
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
