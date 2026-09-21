import SwiftUI
import UIKit

/// Installs the Antigravity runtime on a server and signs its account in.
/// One primary action at a time; the runtime's other actions follow it, and
/// the destructive ones sit last.
struct SettingsAntigravitySetupView: View {
    let manager: any FeatureServerSettingsManaging
    let environmentID: String
    let instanceID: String
    let authMethod: String
    let binaryPath: String
    var serverName: String? = nil
    @SwiftUI.Environment(\.openURL) private var openURL
    @State private var provider: ServerProviderSnapshot?
    /// Set once the provider's first answer lands, so a server that has not
    /// replied yet is not mistaken for one too old to support setup.
    @State private var loaded = false
    @State private var auth: NativeProviderAuthState?
    @State private var installation: NativeProviderInstallState?
    @State private var pendingAction: String?
    @State private var errorMessage: String?
    @State private var authError: String?
    @State private var installError: String?
    @State private var callbackURL = ""
    @State private var retry = 0
    @State private var confirmLogout = false
    @State private var confirmRemoval = false

    private var usesBrowser: Bool { authMethod == "oauth-personal" || authMethod == "oauth-business" }
    private var installed: Bool { provider?.installed == true || (binaryPath.isEmpty && installation?.installedVersion != nil) }
    private var environmentName: String { serverName ?? "this server" }
    private var stateReady: Bool { auth != nil && installation != nil && authError == nil && installError == nil }
    private var signedIn: Bool { provider?.auth.status == "authenticated" || auth?.phase == "succeeded" }
    private var pending: Bool { pendingAction != nil }

    var body: some View {
        content
            .navigationTitle("Antigravity")
            .navigationBarTitleDisplayMode(.inline)
            .task(id: retry) { await observeAuth() }
            .task(id: retry) { await observeInstallation() }
            .task(id: retry) { await observeProvider() }
            .onChange(of: auth?.flowId) { _, _ in callbackURL = "" }
    }

    @ViewBuilder
    private var content: some View {
        if loaded, provider?.setup == nil {
            ContentUnavailableView {
                Label("Update \(serverName ?? "This Server")", systemImage: "arrow.down.circle")
            } description: {
                Text("Update \(environmentName) to install Antigravity and sign in from here.")
            } actions: {
                Button("Check Again") { Task { await refresh() } }
            }
            .background(T3Colors.background)
        } else {
            SettingsForm {
                if !loaded || installation == nil || auth == nil {
                    if let error = errorMessage ?? authError ?? installError {
                        SettingsRetrySection(message: error) { Task { await refresh() } }
                    } else {
                        Section { SettingsPlaceholderRows(count: 3) }
                    }
                } else if let installation, let auth {
                    runtimeSection(installation, auth: auth)
                    authSection(auth)
                    destructiveSection(installation, auth: auth)
                }
            }
            .refreshable { await refresh() }
        }
    }

    // MARK: - Runtime

    private func runtimeSection(_ installation: NativeProviderInstallState, auth: NativeProviderAuthState) -> some View {
        let managesRuntime = provider?.setup?.canInstall == true && binaryPath.isEmpty
        let updateAvailable = installation.installedVersion != nil && installation.version != nil
            && installation.version != installation.installedVersion
        return Section {
            if !binaryPath.isEmpty {
                LabeledContent("Executable") {
                    Text(binaryPath).font(.system(.footnote, design: .monospaced)).lineLimit(2)
                }
            } else {
                LabeledContent("Runtime") {
                    if updateAvailable, let installedVersion = installation.installedVersion, let version = installation.version {
                        Text("\(installedVersion) → \(version)")
                    } else {
                        Text(installation.installedVersion ?? (installed ? "Installed" : "Not Installed"))
                    }
                }
            }

            if installation.isActive {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        if installation.phase == "downloading", let total = installation.totalBytes, total > 0 {
                            ProgressView(value: min(installation.downloadedBytes, total), total: total)
                            Text("\(Int(installation.downloadedBytes / 1_000_000)) of \(Int(total / 1_000_000)) MB")
                                .font(T3Typography.supporting.monospacedDigit())
                                .foregroundStyle(T3Colors.textSecondary)
                        } else {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text(installation.phase == "downloading" ? "Downloading…" : installation.phase == "extracting" ? "Extracting…" : "Verifying…")
                                    .foregroundStyle(T3Colors.textSecondary)
                            }
                        }
                    }
                    if let operationID = installation.operationId {
                        Button("Cancel") { Task { await perform(.cancelInstall(operationID: operationID), key: "cancelInstall") } }
                            .buttonStyle(.bordered)
                            .disabled(pending)
                    }
                }
            } else if managesRuntime {
                if installation.installedVersion == nil {
                    primaryButton("Install Antigravity", key: "install") {
                        Task { await perform(.startInstall, key: "install") }
                    }
                    .disabled(!stateReady || auth.isActive || pending)
                } else {
                    actionRow(updateAvailable ? "Update to \(installation.version ?? "Latest")" : "Reinstall", key: "install") {
                        Task { await perform(.startInstall, key: "install") }
                    }
                    .disabled(!stateReady || auth.isActive || pending)
                }
            }
        } header: {
            Text("Runtime")
        } footer: {
            SettingsFooter(
                text: runtimeFooter(installation),
                error: installError
            )
        }
    }

    private func runtimeFooter(_ installation: NativeProviderInstallState) -> String {
        if !binaryPath.isEmpty {
            return "This account uses a custom executable. Clear its binary path in the account's configuration to manage the downloaded runtime."
        }
        if let message = installation.message { return message }
        return installed
            ? "Antigravity runs on \(environmentName)."
            : "Install the official Google runtime on \(environmentName) before signing in."
    }

    // MARK: - Sign-in

    @ViewBuilder
    private func authSection(_ auth: NativeProviderAuthState) -> some View {
        Section {
            LabeledContent("Account") {
                HStack(spacing: 8) {
                    if auth.isActive { ProgressView() }
                    Text(signedIn ? "Signed In" : auth.isActive ? "Signing In…" : "Signed Out")
                        .foregroundStyle(signedIn ? T3Colors.success : T3Colors.textSecondary)
                }
            }
            if let url = auth.signInURL {
                primaryButton("Open Sign-In Page", key: "open") { openURL(url) }
                    .contextMenu {
                        Button("Copy Sign-In Link", systemImage: "doc.on.doc") { UIPasteboard.general.url = url }
                    }
                TextField("Paste the final page's address", text: $callbackURL)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                actionRow("Continue", key: "complete") {
                    if let flowID = auth.flowId {
                        Task { await perform(.completeAuth(flowID: flowID, callbackURL: callbackURL), key: "complete") }
                    }
                }
                .disabled(pending || callbackURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || callbackURL.count > 16_384)
            }
            if auth.isActive, let flowID = auth.flowId {
                actionRow("Cancel Sign-In", key: "cancelAuth") {
                    Task { await perform(.cancelAuth(flowID: flowID), key: "cancelAuth") }
                }
                .disabled(pending)
            } else if !auth.isActive, provider?.setup?.canAuthenticate == true, !signedIn {
                primaryButton(usesBrowser ? "Sign In with Google" : "Connect", key: "signIn") {
                    Task { await perform(.startAuth, key: "signIn") }
                }
                .disabled(!installed || !stateReady || installation?.isActive == true || pending)
            }
        } header: {
            Text(usesBrowser ? "Google Account" : "Credentials")
        } footer: {
            SettingsFooter(text: authFooter(auth), error: authError ?? errorMessage)
        }
    }

    private func authFooter(_ auth: NativeProviderAuthState) -> String? {
        var lines: [String] = []
        if let message = auth.message { lines.append(message) }
        if auth.signInURL != nil {
            lines.append("If the final localhost page does not load, copy its full address from the browser and paste it above. Touch and hold Open Sign-In Page to copy the link.")
            if let expiry = auth.expiresAt, let date = ISO8601DateFormatter().date(from: expiry) {
                lines.append("The link expires at \(date.formatted(date: .omitted, time: .shortened)).")
            }
        } else if auth.phase == "waiting" {
            lines.append("Sign-in is open in another client. Complete or cancel it there.")
        } else if !installed {
            lines.append("Install the runtime first.")
        }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    // MARK: - Destructive

    @ViewBuilder
    private func destructiveSection(_ installation: NativeProviderInstallState, auth: NativeProviderAuthState) -> some View {
        let canSignOut = !auth.isActive && provider?.setup?.canAuthenticate == true && signedIn
        let canRemove = installation.canRemove && binaryPath.isEmpty && provider?.setup?.canInstall == true && !installation.isActive
        if canSignOut || canRemove {
            Section {
                if canSignOut {
                    Button(role: .destructive) { confirmLogout = true } label: {
                        rowLabel(usesBrowser ? "Sign Out of Google" : "Disconnect", key: "logout")
                    }
                    .disabled(pending)
                    .confirmationDialog("Disconnect this Antigravity account?", isPresented: $confirmLogout, titleVisibility: .visible) {
                        Button("Disconnect", role: .destructive) { Task { await perform(.logout, key: "logout") } }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("This stops this account’s running threads on \(environmentName). Thread history is kept.")
                    }
                }
                if canRemove {
                    Button(role: .destructive) { confirmRemoval = true } label: {
                        rowLabel("Remove Downloaded Runtime", key: "removeInstall")
                    }
                    .disabled(pending || auth.isActive)
                    .confirmationDialog("Remove the downloaded runtime?", isPresented: $confirmRemoval, titleVisibility: .visible) {
                        Button("Remove Runtime", role: .destructive) { Task { await perform(.removeInstall, key: "removeInstall") } }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("Other accounts on this server may share this runtime. Sign-in and thread history are kept. Active processes must stop before removal.")
                    }
                }
            }
        }
    }

    // MARK: - Rows

    private func primaryButton(_ title: String, key: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if pendingAction == key { ProgressView() }
                Text(title)
            }
            .frame(maxWidth: .infinity)
        }
        .t3ProminentButtonStyle()
        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
    }

    private func actionRow(_ title: String, key: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { rowLabel(title, key: key) }
    }

    private func rowLabel(_ title: String, key: String) -> some View {
        HStack {
            Text(title)
            if pendingAction == key {
                Spacer()
                ProgressView()
            }
        }
    }

    // MARK: - Requests

    private func refresh() async {
        retry += 1
    }

    private func perform(_ action: NativeProviderSetupAction, key: String) async {
        guard pendingAction == nil else { return }
        pendingAction = key
        errorMessage = nil
        defer { pendingAction = nil }
        do {
            try await manager.providerSetup(environmentID: environmentID, instanceID: instanceID, action: action)
            if case .completeAuth = action { callbackURL = "" }
        } catch {
            if !Task.isCancelled {
                PlatformHapticEngine.shared.play(.error)
                errorMessage = error.localizedDescription
            }
        }
    }

    private func observeAuth() async {
        authError = nil
        do {
            for try await state in try await manager.providerAuthEvents(environmentID: environmentID, instanceID: instanceID) {
                try Task.checkCancellation()
                if state.phase == "succeeded", auth?.phase != "succeeded", auth != nil {
                    PlatformHapticEngine.shared.play(.success)
                }
                auth = state
            }
        } catch {
            if !Task.isCancelled { authError = error.localizedDescription }
        }
    }

    private func observeInstallation() async {
        installError = nil
        do {
            for try await state in try await manager.providerInstallEvents(environmentID: environmentID, instanceID: instanceID) {
                try Task.checkCancellation()
                installation = state
            }
        } catch {
            if !Task.isCancelled { installError = error.localizedDescription }
        }
    }

    private func observeProvider() async {
        do {
            let config = try await manager.providerModelConfiguration(environmentID: environmentID)
            try Task.checkCancellation()
            provider = config.providers.first { $0.instanceId == instanceID }
            loaded = true
            for try await providers in try await manager.providerUpdateEvents(environmentID: environmentID) {
                try Task.checkCancellation()
                provider = providers.first { $0.instanceId == instanceID }
            }
        } catch {
            if !Task.isCancelled { errorMessage = error.localizedDescription }
        }
    }
}
