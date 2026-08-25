import SwiftUI

/// Server-authoritative provider settings.
///
/// Web renders this whole tree from the settings schema's `providerSettingsForm`
/// annotations; almost none of it is reachable from a phone (binary paths, CLI
/// launch arguments, config directories), so this screen carries the fields a
/// person would actually change from one — starting with Claude's
/// auto-compaction threshold, which is what keeps a long-lived thread from
/// burning usage on full history.
///
/// The write lands on one paired server. Without a connected environment there
/// is nothing to write to, so the section stays out rather than offering a row
/// that cannot save — the same rule the Browser section in Integrations follows.
public struct SettingsAgentsView: View {
    private let serverSettings: any FeatureServerSettingsManaging
    private let environmentID: String?
    /// The server's own answer, republished whenever the config subscription
    /// reports it changing.
    private let preferences: FeatureEnvironmentPreferences?

    @State private var isEditingAutoCompact = false

    public init(
        serverSettings: any FeatureServerSettingsManaging,
        environmentID: String?,
        preferences: FeatureEnvironmentPreferences?
    ) {
        self.serverSettings = serverSettings
        self.environmentID = environmentID
        self.preferences = preferences
    }

    private var storedAutoCompactWindow: String {
        preferences?.claudeAutoCompactWindow ?? ""
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if let environmentID, preferences != nil {
                    SettingsSection(
                        title: "Claude",
                        footer: """
                        Claude summarizes the conversation once it passes this many tokens, \
                        without changing the model's context window. You can also send \
                        /compact in any Claude thread.
                        """
                    ) {
                        Button {
                            isEditingAutoCompact = true
                        } label: {
                            SettingsValueNavigationRow(
                                title: "Auto-compact after",
                                systemImage: "arrow.down.right.and.arrow.up.left",
                                value: ClaudeAutoCompactWindow.summary(for: storedAutoCompactWindow)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                    .sheet(isPresented: $isEditingAutoCompact) {
                        NavigationStack {
                            ClaudeAutoCompactWindowEditor(
                                stored: storedAutoCompactWindow,
                                save: { normalized in
                                    try await serverSettings.updateServerSettings(
                                        environmentID: environmentID,
                                        patch: ServerSettingsPatchInput(
                                            claudeAutoCompactWindow: normalized
                                        )
                                    )
                                },
                                onFinished: { isEditingAutoCompact = false }
                            )
                        }
                        .presentationDragIndicator(.visible)
                    }
                } else {
                    SettingsSection(
                        title: "Claude",
                        footer: "Connect a server to change its agent settings."
                    ) {
                        SettingsValueNavigationRow(
                            title: "Auto-compact after",
                            systemImage: "arrow.down.right.and.arrow.up.left",
                            value: "Unavailable",
                            isEnabled: false
                        )
                    }
                }
            }
            .padding(.vertical, 18)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .navigationTitle("Agents")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Entry sheet for the auto-compaction threshold.
///
/// A dedicated sheet rather than an inline field because the value is validated
/// against a range: an inline field would have to grow an error line inside a
/// grouped row, and the row is also the only place the current value is shown.
struct ClaudeAutoCompactWindowEditor: View {
    let stored: String
    /// Returns the server's own answer, which is what makes a clamped or
    /// rejected value visible instead of silently accepted.
    let save: (String) async throws -> FeatureEnvironmentPreferences
    let onFinished: () -> Void

    @State private var text: String
    @State private var errorMessage: String?
    @State private var isSaving = false
    @FocusState private var isFieldFocused: Bool

    init(
        stored: String,
        save: @escaping (String) async throws -> FeatureEnvironmentPreferences,
        onFinished: @escaping () -> Void
    ) {
        self.stored = stored
        self.save = save
        self.onFinished = onFinished
        _text = State(initialValue: ClaudeAutoCompactWindow.editableText(for: stored))
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                SettingsSection(title: "Tokens") {
                    VStack(alignment: .leading, spacing: 12) {
                        TextField("e.g. 300,000", text: $text)
                            .keyboardType(.numberPad)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.done)
                            .focused($isFieldFocused)
                            .disabled(isSaving)
                            .settingsInputField()
                            .accessibilityLabel("Auto-compact after, in tokens")

                        if let errorMessage {
                            SettingsErrorBanner(message: errorMessage)
                        }

                        SettingsActionButton(
                            title: "Save",
                            systemImage: "checkmark",
                            tone: .primary,
                            isBusy: isSaving,
                            action: commit
                        )
                        .padding(.horizontal, SettingsMetrics.rowPadding)

                        // Clearing is the way back to Claude's default, and an
                        // empty field is easy to mistake for "unchanged", so the
                        // action says what it does.
                        if ClaudeAutoCompactWindow.tokens(from: stored) != nil {
                            SettingsActionButton(
                                title: "Use Claude's default",
                                systemImage: "arrow.uturn.backward",
                                isDisabled: isSaving
                            ) {
                                text = ""
                                commit()
                            }
                            .padding(.horizontal, SettingsMetrics.rowPadding)
                        }
                    }
                }

                SettingsFootnote(
                    """
                    Between \(ClaudeAutoCompactWindow.minimumTokens.formatted()) and \
                    \(ClaudeAutoCompactWindow.maximumTokens.formatted()) tokens. Leave empty to \
                    use Claude's default.
                    """
                )
            }
            .padding(.vertical, 18)
        }
        .scrollDismissesKeyboard(.interactively)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .navigationTitle("Auto-compact after")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { onFinished() }
                    .disabled(isSaving)
            }
        }
        .onAppear { isFieldFocused = true }
    }

    private func commit() {
        switch ClaudeAutoCompactWindow.normalize(text) {
        case let .failure(failure):
            errorMessage = ClaudeAutoCompactWindow.message(for: failure)
        case let .success(normalized):
            errorMessage = nil
            isSaving = true
            Task { @MainActor in
                do {
                    _ = try await save(normalized)
                    onFinished()
                } catch {
                    errorMessage = "Could not save: \(error.localizedDescription)"
                }
                isSaving = false
            }
        }
    }
}
