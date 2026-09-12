import SwiftUI
import UIKit

struct SettingsAntigravitySetupView: View {
    let manager: any FeatureServerSettingsManaging
    let environmentID: String
    let instanceID: String
    let authMethod: String
    let binaryPath: String
    @SwiftUI.Environment(\.openURL) private var openURL
    @State private var provider: ServerProviderSnapshot?
    @State private var auth: NativeProviderAuthState?
    @State private var installation: NativeProviderInstallState?
    @State private var pending = false
    @State private var errorMessage: String?
    @State private var authError: String?
    @State private var installError: String?
    @State private var callbackURL = ""
    @State private var retry = 0
    @State private var confirmLogout = false
    @State private var confirmRemoval = false

    private var usesBrowser: Bool { authMethod == "oauth-personal" || authMethod == "oauth-business" }
    private var installed: Bool { provider?.installed == true || (binaryPath.isEmpty && installation?.installedVersion != nil) }
    private var environmentName: String { "the selected server" }
    private var stateReady: Bool { auth != nil && installation != nil && authError == nil && installError == nil }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Antigravity runs on \(environmentName).").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                if let error = errorMessage ?? authError ?? installError { SettingsErrorBanner(message: error) }
                if provider?.setup == nil {
                    Text("Update this server to install Antigravity and sign in here.").font(T3Typography.supporting)
                } else {
                    runtimeSection
                    authSection
                }
                if pending { ProgressView("Updating setup…").frame(maxWidth: .infinity) }
                Button("Refresh setup status") { retry += 1 }.disabled(pending)
            }.padding(18)
        }
        .background(T3Colors.background)
        .navigationTitle("Antigravity setup").navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(pending)
        .task(id: retry) { await observeAuth() }
        .task(id: retry) { await observeInstallation() }
        .task(id: retry) { await observeProvider() }
        .onChange(of: auth?.flowId) { _, _ in callbackURL = "" }
        .confirmationDialog("Disconnect this Antigravity account?", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { Task { await perform(.logout) } }
        } message: { Text("This stops this account’s running threads on \(environmentName). Thread history is kept.") }
        .confirmationDialog("Remove the downloaded runtime?", isPresented: $confirmRemoval, titleVisibility: .visible) {
            Button("Remove runtime", role: .destructive) { Task { await perform(.removeInstall) } }
        } message: { Text("Other accounts on this server may share this runtime. Sign-in and thread history are kept. Active processes must stop before removal.") }
    }

    private var runtimeSection: some View {
        SettingsSection(title: "Runtime") {
            VStack(alignment: .leading, spacing: 12) {
                if let installation {
                    Text(installation.message ?? (installed ? "Antigravity is installed." : "Install the official Google runtime before signing in."))
                        .font(T3Typography.supporting)
                    if let version = installation.installedVersion { LabeledContent("Installed", value: version) }
                    if installation.phase == "downloading" {
                        if let total = installation.totalBytes, total > 0 {
                            ProgressView(value: min(installation.downloadedBytes, total), total: total)
                            Text("\(Int(installation.downloadedBytes / 1_000_000)) of \(Int(total / 1_000_000)) MB").font(.caption.monospacedDigit())
                        } else { ProgressView("Downloading…") }
                    } else if installation.isActive { ProgressView(installation.phase == "extracting" ? "Extracting…" : "Verifying…") }
                    if installation.isActive, let operationID = installation.operationId {
                        Button("Cancel installation") { Task { await perform(.cancelInstall(operationID: operationID)) } }
                    } else if provider?.setup?.canInstall == true, binaryPath.isEmpty {
                        Button(installation.installedVersion == nil ? "Install Antigravity" : installation.version != installation.installedVersion ? "Update Antigravity" : "Reinstall Antigravity") {
                            Task { await perform(.startInstall) }
                        }.disabled(!stateReady || auth?.isActive == true)
                        if installation.canRemove { Button("Remove downloaded runtime", role: .destructive) { confirmRemoval = true }.disabled(auth?.isActive == true) }
                    }
                    if !binaryPath.isEmpty { Text("This account uses a custom executable. Clear its binary path in account settings to manage the downloaded runtime.").font(.caption).foregroundStyle(T3Colors.textSecondary) }
                } else { ProgressView("Reading installation status…") }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(SettingsMetrics.rowPadding).disabled(pending)
        }
    }

    private var authSection: some View {
        SettingsSection(title: usesBrowser ? "Google sign-in" : "Credentials") {
            VStack(alignment: .leading, spacing: 12) {
                if let auth {
                    Text(auth.message ?? (auth.phase == "succeeded" || provider?.auth.status == "authenticated" ? "Connected." : auth.isActive ? "Waiting for sign-in to complete." : "Connect using this account’s saved sign-in method."))
                        .font(T3Typography.supporting)
                    if auth.isActive { ProgressView().controlSize(.small) }
                    if let url = auth.signInURL {
                        Button("Open sign-in page") { openURL(url) }
                        Button("Copy sign-in link") { UIPasteboard.general.url = url }
                        if let expiry = auth.expiresAt, let date = ISO8601DateFormatter().date(from: expiry) { Text("Link expires \(date.formatted(date: .omitted, time: .shortened)).").font(.caption).foregroundStyle(T3Colors.textSecondary) }
                        Text("If the final localhost page does not load, copy its full address from the browser and paste it below.").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                        TextField("http://127.0.0.1:…", text: $callbackURL).textContentType(.URL).keyboardType(.URL)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder)
                        Button("Continue") {
                            if let flowID = auth.flowId { Task { await perform(.completeAuth(flowID: flowID, callbackURL: callbackURL)) } }
                        }.disabled(callbackURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || callbackURL.count > 16_384)
                    } else if auth.phase == "waiting" { Text("Sign-in is open in another client. Complete or cancel it there.").font(T3Typography.supporting) }
                    if auth.isActive, let flowID = auth.flowId {
                        Button("Cancel sign-in") { Task { await perform(.cancelAuth(flowID: flowID)) } }
                    } else if !auth.isActive, provider?.setup?.canAuthenticate == true {
                        if provider?.auth.status != "authenticated" {
                            Button(usesBrowser ? "Sign in with Google" : "Connect") { Task { await perform(.startAuth) } }
                                .disabled(!installed || !stateReady || installation?.isActive == true)
                        }
                        Button(usesBrowser ? "Sign out of Google" : "Disconnect", role: .destructive) { confirmLogout = true }
                    }
                } else { ProgressView("Reading sign-in status…") }
            }.buttonStyle(.bordered).controlSize(.large).frame(maxWidth: .infinity, alignment: .leading)
                .padding(SettingsMetrics.rowPadding).disabled(pending)
        }
    }

    private func perform(_ action: NativeProviderSetupAction) async {
        guard !pending else { return }
        pending = true; errorMessage = nil
        defer { pending = false }
        do {
            try await manager.providerSetup(environmentID: environmentID, instanceID: instanceID, action: action)
            if case .completeAuth = action { callbackURL = "" }
        } catch { if !Task.isCancelled { errorMessage = error.localizedDescription } }
    }
    private func observeAuth() async {
        authError = nil
        do { for try await state in try await manager.providerAuthEvents(environmentID: environmentID, instanceID: instanceID) {
            try Task.checkCancellation(); auth = state
        }} catch { if !Task.isCancelled { authError = error.localizedDescription } }
    }
    private func observeInstallation() async {
        installError = nil
        do { for try await state in try await manager.providerInstallEvents(environmentID: environmentID, instanceID: instanceID) {
            try Task.checkCancellation(); installation = state
        }} catch { if !Task.isCancelled { installError = error.localizedDescription } }
    }
    private func observeProvider() async {
        do {
            let config = try await manager.providerModelConfiguration(environmentID: environmentID)
            try Task.checkCancellation(); provider = config.providers.first { $0.instanceId == instanceID }
            for try await providers in try await manager.providerUpdateEvents(environmentID: environmentID) {
                try Task.checkCancellation(); provider = providers.first { $0.instanceId == instanceID }
            }
        } catch { if !Task.isCancelled { errorMessage = error.localizedDescription } }
    }
}
