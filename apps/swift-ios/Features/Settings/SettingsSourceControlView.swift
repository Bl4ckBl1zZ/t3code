import SwiftUI

/// What the Source Control page reads and writes on one server.
@MainActor
protocol FeatureGitHubSettingsManaging: AnyObject {
    /// Whether the server keeps GitHub choices per host: its settings carry
    /// them, or its discovery reports gh's logins. Asked once per server per
    /// session; false while the server cannot be asked.
    func supportsGitHubSettings(environmentID: String) async -> Bool
    /// The server's saved choices and its GitHub discovery entry, read fresh.
    func gitHubSettings(environmentID: String) async throws -> FeatureGitHubSettingsState
    /// Applies one `github` patch. Needs the `orchestration:operate` scope.
    func updateGitHubSettings(environmentID: String, patch: GitHubSettingsPatch) async throws
}

struct FeatureGitHubSettingsState: Equatable {
    /// Nil on a server that never saved any GitHub choice.
    var settings: GitHubSettings?
    /// Nil when the server's discovery has no GitHub entry.
    var provider: SourceControlProviderDiscoveryItem?
}

/// One GitHub host as the Source Control page lists it.
struct GitHubHostSection: Identifiable, Equatable {
    let host: String
    /// Off means requests to the host get no credential at all.
    let enabled: Bool
    /// The pinned login while gh still holds it; nil follows gh's active one.
    let pinnedAccount: String?
    /// A pinned login gh no longer holds, so the active one is used instead.
    let stalePin: String?
    /// gh's active login for the host: the one used when nothing is pinned.
    let activeAccount: String?
    /// Logins gh holds that work and can be pinned.
    let selectableAccounts: [String]
    /// Logins gh holds but cannot use.
    let brokenAccounts: [SourceControlProviderAuth.Account]
    /// A variable such as `GH_TOKEN` that overrides the chosen account.
    let environmentVariable: String?
    let hasSavedToken: Bool

    var id: String { host }

    static let defaultHost = "github.com"

    /// Every host the server knows of — its saved choices and tokens and gh's
    /// logins — with `github.com` first and always present, since a saved
    /// token is how GitHub works on a server without gh.
    static func sections(
        settings: GitHubSettings?,
        accounts: [SourceControlProviderAuth.Account]
    ) -> [GitHubHostSection] {
        let settings = settings ?? GitHubSettings()
        let savedTokenHosts = settings.tokens.filter { !$0.value.isEmpty }.keys
        var others = Set(settings.hosts.keys)
            .union(savedTokenHosts)
            .union(accounts.map { GitHubSettings.normalizedHost($0.host) })
        others.remove(defaultHost)
        return ([defaultHost] + others.sorted()).map { host in
            let entries = accounts.filter { GitHubSettings.normalizedHost($0.host) == host }
            let stored = entries.filter { $0.environmentVariable == nil }
            let selectable = stored.filter(\.authenticated)
            let choice = settings.hosts[host]
            let pin = choice?.account
            let pinHeld = pin.map { pin in selectable.contains { $0.account == pin } } ?? false
            return GitHubHostSection(
                host: host,
                enabled: choice?.enabled ?? true,
                pinnedAccount: pinHeld ? pin : nil,
                stalePin: pinHeld ? nil : pin,
                activeAccount: (selectable.first(where: \.active) ?? selectable.first)?.account,
                selectableAccounts: selectable.map(\.account),
                brokenAccounts: stored.filter { !$0.authenticated },
                environmentVariable: entries.lazy.compactMap(\.environmentVariable).first,
                hasSavedToken: settings.hasSavedToken(host)
            )
        }
    }
}

extension GitHubSettings {
    /// These settings once the server applies `patch`, shown while the write
    /// is in flight and until the reload after it lands.
    func applying(_ patch: GitHubSettingsPatch) -> GitHubSettings {
        var next = self
        if let hosts = patch.hosts { next.hosts = hosts }
        for (host, token) in patch.tokens ?? [:] {
            next.tokens[host] = token.isEmpty ? nil : Self.redactedToken
        }
        return next
    }
}

/// One server's GitHub hosts: whether each is used, which `gh` login it uses,
/// and a token saved on the server that takes precedence over both. Changes
/// save as they are made. Pushed from a server's details.
struct SettingsSourceControlView: View {
    let environmentID: String
    let manager: any FeatureGitHubSettingsManaging

    @State private var state: FeatureGitHubSettingsState?
    @State private var loadError: String?
    @State private var reloadError: String?
    /// The write in flight, shown in place of the saved value until it lands.
    @State private var pending: GitHubSettingsPatch?
    @State private var writeError: HostError?
    @State private var tokenTarget: TokenTarget?

    private struct HostError: Equatable {
        let host: String
        let message: String
    }

    private struct TokenTarget: Identifiable {
        let host: String
        let isSaved: Bool
        var id: String { host }
    }

    private var displayedSettings: GitHubSettings {
        let saved = state?.settings ?? GitHubSettings()
        return pending.map(saved.applying) ?? saved
    }

    private var sections: [GitHubHostSection] {
        GitHubHostSection.sections(
            settings: displayedSettings,
            accounts: state?.provider?.auth.accounts ?? []
        )
    }

    var body: some View {
        SettingsForm {
            if state != nil {
                ForEach(sections) { section in
                    hostSection(section)
                }
                if let reloadError {
                    Section {} footer: { SettingsFooter(error: reloadError) }
                }
            } else if let loadError {
                SettingsRetrySection(message: loadError) {
                    Task { await load() }
                }
            } else {
                Section {
                    SettingsPlaceholderRows(count: 3)
                } footer: {
                    Text("Reading GitHub accounts on the server…")
                }
            }
        }
        .navigationTitle("Source Control")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: environmentID) { await load() }
        .refreshable { await load() }
        .sheet(item: $tokenTarget) { target in
            SettingsGitHubTokenSheet(host: target.host, isSaved: target.isSaved) { patch in
                await write(patch)
            }
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private func hostSection(_ section: GitHubHostSection) -> some View {
        Section {
            Toggle(isOn: Binding(
                get: { section.enabled },
                set: { enabled in change(section.host, enabled: enabled) }
            )) {
                SettingsTileLabel(
                    title: "Use GitHub on This Host",
                    systemImage: "power",
                    tint: section.enabled ? .green : .gray
                )
            }
            .disabled(pending != nil)

            accountRow(section)

            if section.stalePin != nil {
                Button("Use Active Login") { change(section.host, account: .some(nil)) }
                    .disabled(pending != nil)
            }

            Button {
                tokenTarget = TokenTarget(host: section.host, isSaved: section.hasSavedToken)
            } label: {
                LabeledContent {
                    Text(section.hasSavedToken ? "Saved" : "Not Set")
                        .foregroundStyle(T3Colors.textSecondary)
                } label: {
                    SettingsTileLabel(title: "Saved Token", systemImage: "key.fill", tint: .yellow)
                }
            }
            .disabled(pending != nil)
            .accessibilityHint("Saves or removes a GitHub token for \(section.host) on the server")
        } header: {
            Text(section.host)
        } footer: {
            SettingsFooter(
                text: Self.footer(section),
                error: writeError?.host == section.host ? writeError?.message : nil
            )
        }
    }

    /// A picker once gh holds more than one usable login, the one login
    /// otherwise, and nothing while gh holds none.
    @ViewBuilder
    private func accountRow(_ section: GitHubHostSection) -> some View {
        let label = SettingsTileLabel(title: "Account", systemImage: "person.crop.circle", tint: .blue)
        if section.selectableAccounts.count > 1 {
            Picker(selection: Binding(
                get: { section.pinnedAccount },
                set: { account in
                    guard account != section.pinnedAccount else { return }
                    change(section.host, account: .some(account))
                }
            )) {
                Text(section.activeAccount.map { "Active gh account (\($0))" } ?? "Active gh account")
                    .tag(String?.none)
                ForEach(section.selectableAccounts, id: \.self) { account in
                    Text(account).tag(Optional(account))
                }
            } label: {
                label
            }
            .pickerStyle(.menu)
            .disabled(!section.enabled || pending != nil)
        } else if let account = section.selectableAccounts.first {
            LabeledContent {
                Text(account)
            } label: {
                label
            }
        }
    }

    /// Where the host's credential comes from, then anything overriding or
    /// breaking it.
    static func footer(_ section: GitHubHostSection) -> String {
        var lines = ["Requests use a saved token first, then GH_TOKEN, then the gh account."]
        if !section.enabled {
            lines.append("Turned off, \(section.host) gets no credential, saved token included.")
        } else if section.selectableAccounts.isEmpty, section.brokenAccounts.isEmpty, !section.hasSavedToken,
                  section.environmentVariable == nil {
            lines.append("Run gh auth login on the server, then pull to refresh to choose an account.")
        }
        if section.stalePin != nil {
            lines.append("The chosen login is no longer signed in, so the active gh login is used.")
        }
        for entry in section.brokenAccounts {
            lines.append("\(entry.account) can't be used: \(entry.error ?? "gh reports this login as invalid.")")
        }
        if let variable = section.environmentVariable {
            lines.append("\(variable) is set on the server, so it overrides the account chosen here until it is unset.")
        }
        return lines.joined(separator: "\n")
    }

    // MARK: - Loading and writing

    private func load() async {
        do {
            let next = try await manager.gitHubSettings(environmentID: environmentID)
            state = next
            loadError = nil
            reloadError = nil
        } catch {
            if error is CancellationError || Task.isCancelled { return }
            let message = "Couldn't read GitHub settings. \(error.localizedDescription)"
            if state == nil { loadError = message } else { reloadError = message }
        }
    }

    private func change(_ host: String, enabled: Bool? = nil, account: String?? = nil) {
        guard pending == nil else { return }
        let patch = GitHubSettingsPatch.changingHost(
            host,
            in: displayedSettings.hosts,
            enabled: enabled,
            account: account
        )
        PlatformHapticEngine.shared.playSelection()
        Task {
            if let failure = await write(patch) {
                writeError = HostError(host: host, message: failure)
            }
        }
    }

    /// Sends one patch and returns the failure to show, or nil once it saved.
    /// A save then re-reads discovery, since the account in use may have
    /// changed; the saved values show meanwhile.
    private func write(_ patch: GitHubSettingsPatch) async -> String? {
        pending = patch
        writeError = nil
        do {
            try await manager.updateGitHubSettings(environmentID: environmentID, patch: patch)
            state?.settings = (state?.settings ?? GitHubSettings()).applying(patch)
            pending = nil
            Task { await load() }
            return nil
        } catch {
            pending = nil
            PlatformHapticEngine.shared.play(.error)
            return "Couldn't save. \(error.localizedDescription)"
        }
    }
}

/// Saves or removes the GitHub token for one host. Write-only: a saved token
/// is never shown, only whether there is one.
private struct SettingsGitHubTokenSheet: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let host: String
    let isSaved: Bool
    /// Returns the failure to show, or nil once the server saved the change.
    let onWrite: (GitHubSettingsPatch) async -> String?

    @State private var token = ""
    @State private var isSaving = false
    @State private var error: String?
    @State private var confirmingRemoval = false

    private var newTokenURL: URL? {
        URL(string: "https://\(host)/settings/personal-access-tokens/new")
    }

    var body: some View {
        NavigationStack {
            SettingsForm {
                Section {
                    SecureField(isSaved ? "New token to replace the saved one" : "Token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit(save)
                        .disabled(isSaving)
                } header: {
                    Text(host)
                } footer: {
                    SettingsFooter(
                        text: "A token saved here is used before GH_TOKEN and the gh login, so GitHub works without the GitHub CLI. Give it read and write access to pull requests and contents. It stays on the server and can't be viewed again.",
                        error: error
                    )
                }

                if let newTokenURL {
                    Section {
                        Link(destination: newTokenURL) {
                            Label("Create a Token", systemImage: "arrow.up.right.square")
                        }
                    }
                }

                if isSaved {
                    Section {
                        Button("Remove Token", role: .destructive) { confirmingRemoval = true }
                            .foregroundStyle(T3Colors.danger)
                            .disabled(isSaving)
                            .confirmationDialog(
                                "Remove the token saved for \(host)?",
                                isPresented: $confirmingRemoval,
                                titleVisibility: .visible
                            ) {
                                Button("Remove Token", role: .destructive) {
                                    submit(GitHubSettingsPatch.removingToken(host: host))
                                }
                                Button("Cancel", role: .cancel) {}
                            } message: {
                                Text("The server falls back to GH_TOKEN or the gh login.")
                            }
                    }
                }
            }
            .navigationTitle("GitHub Token")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(isSaving)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save)
                        .disabled(isSaving || GitHubSettingsPatch.savingToken(token, host: host) == nil)
                }
            }
        }
    }

    private func save() {
        guard let patch = GitHubSettingsPatch.savingToken(token, host: host) else { return }
        submit(patch)
    }

    private func submit(_ patch: GitHubSettingsPatch) {
        guard !isSaving else { return }
        isSaving = true
        error = nil
        Task {
            let failure = await onWrite(patch)
            isSaving = false
            if let failure {
                error = failure
            } else {
                dismiss()
            }
        }
    }
}
