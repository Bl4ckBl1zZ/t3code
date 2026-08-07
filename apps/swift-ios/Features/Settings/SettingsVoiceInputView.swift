import SwiftUI

// Ported from apps/mobile/src/features/settings/SettingsVoiceInputRouteScreen.tsx.
//
// Every control writes through immediately as a partial patch rather than
// collecting into a Save button, matching React Native: the settings live on the
// account, so two devices editing different fields must not clobber each other.

public struct SettingsVoiceInputView: View {
    private enum Field: Hashable {
        case language
        case dictionary
    }

    private let manager: any FeatureVoiceSettingsManaging

    @State private var status: OpenRouterIntegrationStatus?
    @State private var settings: VoiceInputSettings?
    @State private var audioModels: [OpenRouterModelOption] = []
    @State private var language = ""
    @State private var dictionaryText = ""
    @State private var errorMessage: String?
    @State private var showingOpenRouter = false
    @State private var showingModelPicker = false
    @FocusState private var focusedField: Field?

    public init(manager: any FeatureVoiceSettingsManaging) {
        self.manager = manager
    }

    /// Every control below OpenRouter needs a working credential. Preferences
    /// stay editable-looking but disabled so a disconnected account can still
    /// see what it had configured.
    private var isConnected: Bool {
        status?.isConnected == true && settings != nil
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 28) {
                if let errorMessage {
                    SettingsErrorBanner(message: errorMessage)
                }

                integrationSection
                transcriptionSection
                languageSection
                dictionarySection

                if !isConnected {
                    SettingsFootnote(
                        "Connect OpenRouter to enable these controls. Saved preferences are preserved."
                    )
                }
            }
            .padding(.vertical, 18)
        }
        .scrollDismissesKeyboard(.interactively)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .navigationTitle("Voice Input")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .onChange(of: focusedField) { previous, _ in
            // React Native commits these on blur. Losing focus is the same
            // moment here, and committing on every keystroke would mean a
            // request per character.
            switch previous {
            case .language: commitLanguage()
            case .dictionary: commitDictionary()
            case nil: break
            }
        }
        .sheet(isPresented: $showingOpenRouter, onDismiss: { Task { await reload() } }) {
            NavigationStack {
                SettingsOpenRouterView(manager: manager)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { showingOpenRouter = false }
                        }
                    }
            }
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showingModelPicker, onDismiss: { Task { await reload() } }) {
            NavigationStack {
                SettingsVoiceModelPickerView(
                    manager: manager,
                    onSelected: { showingModelPicker = false }
                )
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { showingModelPicker = false }
                    }
                }
            }
            .presentationDragIndicator(.visible)
        }
    }

    private var integrationSection: some View {
        SettingsSection(title: "Integration") {
            Button {
                showingOpenRouter = true
            } label: {
                SettingsValueNavigationRow(
                    title: "OpenRouter",
                    systemImage: "point.3.connected.trianglepath.dotted",
                    value: status?.isConnected == true ? "Connected" : "Connect"
                )
            }
            .buttonStyle(.plain)
        }
    }

    private var transcriptionSection: some View {
        SettingsSection(title: "Transcription") {
            VStack(spacing: 0) {
                SettingsToggleRow(
                    title: "Improve transcripts",
                    systemImage: "wand.and.stars",
                    isOn: Binding(
                        get: { settings?.cleanupEnabled ?? true },
                        set: { enabled in
                            Task { await patch(.init(cleanupEnabled: enabled)) }
                        }
                    )
                )
                .disabled(!isConnected)

                SettingsRowDivider()

                Button {
                    showingModelPicker = true
                } label: {
                    SettingsValueNavigationRow(
                        title: "Model",
                        systemImage: "waveform",
                        value: selectedModelName,
                        isEnabled: isConnected
                    )
                }
                .buttonStyle(.plain)
                .disabled(!isConnected)
            }
        }
    }

    private var languageSection: some View {
        SettingsSection(
            title: "Spoken language",
            footer: "Leave empty to detect the language automatically."
        ) {
            TextField("Automatic", text: $language)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($focusedField, equals: .language)
                .disabled(!isConnected)
                .settingsInputField()
                .accessibilityLabel("Spoken language")
                .onSubmit { focusedField = nil }
        }
    }

    private var dictionarySection: some View {
        SettingsSection(
            title: "Personal dictionary",
            footer: """
                Up to \(VoiceInputSettings.maximumDictionaryEntries) entries. Project and chat \
                content are never added automatically.
                """
        ) {
            TextField("One preferred spelling per line", text: $dictionaryText, axis: .vertical)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .lineLimit(5...)
                .focused($focusedField, equals: .dictionary)
                .disabled(!isConnected)
                .settingsInputField(minHeight: 128)
                .accessibilityLabel("Voice Input personal dictionary")
        }
    }

    private var selectedModelName: String {
        VoiceModelCatalog.displayName(
            for: settings?.model ?? VoiceInputSettings.defaultModel,
            in: audioModels
        )
    }

    @MainActor
    private func reload() async {
        do {
            let status = try await manager.openRouterIntegration()
            let settings = try await manager.voiceInputSettings()
            errorMessage = nil
            self.status = status
            apply(settings)
            guard status.isConnected else {
                audioModels = []
                return
            }
            // A catalog failure only costs the model row its friendly name, so
            // it must not take the whole screen down with it.
            audioModels = (try? await manager.listOpenRouterAudioModels()) ?? []
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func patch(_ patch: VoiceInputSettingsPatch) async {
        do {
            apply(try await manager.patchVoiceInputSettings(patch))
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// The server owns the settled value, so the fields are rewritten from the
    /// response rather than from what was typed.
    private func apply(_ settings: VoiceInputSettings) {
        self.settings = settings
        language = settings.language ?? ""
        dictionaryText = VoiceInputDictionary.text(for: settings.dictionary)
    }

    private func commitLanguage() {
        let next = language.trimmingCharacters(in: .whitespacesAndNewlines)
        guard next != (settings?.language ?? "") else { return }
        Task { await patch(.init(language: next.isEmpty ? .automatic : .explicit(next))) }
    }

    private func commitDictionary() {
        let entries = VoiceInputDictionary.entries(from: dictionaryText)
        guard entries != (settings?.dictionary ?? []) else { return }
        Task { await patch(.init(dictionary: entries)) }
    }
}
