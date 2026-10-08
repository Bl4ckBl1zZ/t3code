import SwiftUI
import UIKit

/// Every saved server, the pages that belong to the one in use, and the way to
/// leave it. Pushed from the server card at the top of Settings.
struct SettingsServersView: View {
    @Bindable var model: FeatureRootModel
    let onAddServer: () -> Void
    /// Pushes a server's details.
    let onShowDetails: (String) -> Void
    /// Called after Disconnect, which leaves nothing for Settings to show.
    let onDisconnected: () -> Void

    @State private var removalTarget: FeatureEnvironment?
    @State private var confirmingDisconnect = false
    @State private var switchingID: String?
    @State private var mergeMethodError: String?

    /// Servers that are on, then the ones switched off on this device.
    private var environments: [FeatureEnvironment] {
        model.snapshot.environments + model.snapshot.switchedOffEnvironments
    }
    private var activeEnvironment: FeatureEnvironment? { environments.first(where: \.isActive) }

    private var isConnected: Bool {
        activeEnvironment != nil && model.snapshot.connection.state != .disconnected
    }

    var body: some View {
        SettingsForm {
            Section {
                ForEach(environments) { environment in
                    serverRow(environment)
                    if let update = environment.permissionUpdate {
                        SettingsPermissionUpdateNotice(
                            model: model,
                            environmentID: environment.id,
                            update: update,
                            onPairAgain: onAddServer
                        )
                    }
                }
            } footer: {
                if environments.count > 1 {
                    Text("Tap a server to switch to it. Swipe to switch one off or remove it; a switched-off server stays saved but doesn't connect or appear in Home.")
                }
            }

            if let activeEnvironment {
                Section {
                    routeLink(.devices)
                    if mergeMethodSupported(activeEnvironment) {
                        SettingsMergeMethodPicker(
                            environmentID: activeEnvironment.id,
                            saved: model.snapshot.preferencesByEnvironment?[activeEnvironment.id]?.pullRequestMergeMethod,
                            manager: (model.client as? any FeatureServerSettingsManaging) ?? EmptyFeatureServerSettingsManager.shared,
                            error: $mergeMethodError
                        )
                    }
                } header: {
                    Text("This Server")
                } footer: {
                    if mergeMethodSupported(activeEnvironment) {
                        SettingsFooter(text: "Merges start with this method unless the project sets its own. Last Used reuses this device's last choice.",
                            error: mergeMethodError)
                    }
                }
            }

            // Balancing picks between machines, so it means nothing with one.
            if environments.count > 1 {
                Section {
                    routeLink(.loadBalancing)
                }
            }

            Section {
                if model.client is any T3ConnectCapable {
                    routeLink(.t3Connect)
                } else {
                    routeLabel(.t3Connect)
                        .opacity(0.5)
                        .accessibilityAddTraits(.isStaticText)
                }
            } footer: {
                Text(model.client is any T3ConnectCapable
                    ? "Optional account sync for relay-managed environments."
                    : "T3 Connect isn't available in this version of the app. Direct and local connections still work.")
            }

            if isConnected {
                Section {
                    Button("Disconnect", role: .destructive) { confirmingDisconnect = true }
                        .foregroundStyle(T3Colors.danger)
                        .confirmationDialog(
                            "Disconnect from this server?",
                            isPresented: $confirmingDisconnect,
                            titleVisibility: .visible
                        ) {
                            Button("Disconnect", role: .destructive) {
                                Task {
                                    await model.disconnect()
                                    onDisconnected()
                                }
                            }
                            Button("Cancel", role: .cancel) {}
                        } message: {
                            Text("Your saved server and credentials stay on this device.")
                        }
                }
            }
        }
        .navigationTitle("Servers")
        .navigationBarTitleDisplayMode(.inline)
        // Only the server in use is asked, and the answer is cached for the
        // session, so its menu can offer Copy MCP URL without a request per row.
        .task(id: activeEnvironment?.isEnabled == true ? activeEnvironment?.id : nil) {
            guard let id = activeEnvironment?.id, activeEnvironment?.isEnabled == true,
                  let probing = model.client as? any FeatureMcpAccessProbing else { return }
            _ = await probing.verifiedMcpURL(environmentID: id)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Add Server", systemImage: "plus", action: onAddServer)
            }
        }
    }

    private func serverRow(_ environment: FeatureEnvironment) -> some View {
        let status = switchingID == environment.id
            ? SettingsServerStatus(title: "Connecting…", symbol: "wifi.exclamationmark", color: T3Colors.warning)
            : SettingsServerStatus.row(for: environment, connection: model.snapshot.connection.state)
        return Button {
            switchTo(environment)
        } label: {
            HStack(spacing: 12) {
                T3SettingsTile(environment.machineSymbol, tint: environment.isActive ? .ink : .gray)
                    .opacity(environment.isEnabled ? 1 : 0.5)
                VStack(alignment: .leading, spacing: 2) {
                    Text(environment.name)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                    let host = SettingsServerStatus.host(environment.endpoint)
                    if !host.isEmpty {
                        Text(host)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 8)
                Text(status.title)
                    .font(T3Typography.supporting)
                    .foregroundStyle(status.color)
                if environment.isActive {
                    Image(systemName: "checkmark")
                        .fontWeight(.semibold)
                        .foregroundStyle(T3Colors.accent)
                        .accessibilityHidden(true)
                }
                Button {
                    onShowDetails(environment.id)
                } label: {
                    Image(systemName: "info.circle")
                        .foregroundStyle(T3Colors.accent)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("\(environment.name) details")
            }
            .contentShape(Rectangle())
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(environment.isActive ? .isSelected : [])
        .accessibilityHint(
            environment.isActive
                ? "Current server"
                : environment.unsupportedReason
                    ?? (environment.isEnabled ? "Switch to this server" : "Switched off")
        )
        .swipeActions(edge: .trailing) {
            if !environment.isActive {
                Button("Remove", role: .destructive) { removalTarget = environment }
            }
            Button(environment.isEnabled ? "Switch Off" : "Switch On") {
                setEnabled(environment, !environment.isEnabled)
            }
            .tint(environment.isEnabled ? T3Colors.textTertiary : T3Colors.success)
        }
        .contextMenu {
            Button {
                setEnabled(environment, !environment.isEnabled)
            } label: {
                Label(environment.isEnabled ? "Switch Off" : "Switch On", systemImage: "power")
            }
            Button {
                onShowDetails(environment.id)
            } label: {
                Label("Details", systemImage: "info.circle")
            }
            // Set once the server confirmed outside agents can sign in: asked on
            // appear for the server in use, from its details for the others.
            if environment.isEnabled, let mcpURL = environment.mcpURL {
                Button {
                    UIPasteboard.general.string = mcpURL.absoluteString
                    T3HUD.show("MCP URL Copied", systemImage: "doc.on.doc")
                } label: {
                    Label("Copy MCP URL", systemImage: "doc.on.doc")
                }
            }
            if !environment.isActive {
                Button(role: .destructive) {
                    removalTarget = environment
                } label: {
                    Label("Remove Server", systemImage: "trash")
                }
            }
        }
        .confirmationDialog(
            "Remove \(environment.name)?",
            isPresented: Binding(
                get: { removalTarget?.id == environment.id },
                set: { if !$0 { removalTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove Server", role: .destructive) {
                Task { await model.removeEnvironment(environment.id) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(environment.name) will need a new pairing code to be added again.")
        }
    }

    private func setEnabled(_ environment: FeatureEnvironment, _ enabled: Bool) {
        PlatformHapticEngine.shared.playSelection()
        Task { await model.setEnvironmentEnabled(environment.id, enabled: enabled) }
    }

    private func switchTo(_ environment: FeatureEnvironment) {
        // A switched-off server never connects; its details page switches it on.
        guard environment.isEnabled else {
            onShowDetails(environment.id)
            return
        }
        guard !environment.isActive, switchingID == nil else { return }
        PlatformHapticEngine.shared.playSelection()
        switchingID = environment.id
        Task {
            await model.activateEnvironment(environment.id)
            switchingID = nil
        }
    }

    private func mergeMethodSupported(_ environment: FeatureEnvironment) -> Bool {
        environment.supportsPullRequests == true
            && model.snapshot.preferencesByEnvironment?[environment.id]?.supportsPullRequestMergeMethod == true
    }

    private func routeLink(_ route: SettingsRoute) -> some View {
        NavigationLink(value: route) { routeLabel(route) }
    }

    private func routeLabel(_ route: SettingsRoute) -> some View {
        SettingsTileLabel(title: route.title, systemImage: route.systemImage, tint: route.tint)
    }
}

/// Shown for a server whose grant on this device predates its granular
/// permissions, which no longer cover Files, Git or settings. Pairing again,
/// or renewing T3 Connect access, receives the current grant.
struct SettingsPermissionUpdateNotice: View {
    let model: FeatureRootModel
    let environmentID: String
    let update: FeaturePermissionUpdate
    /// Opens the pairing flow; pairing the same address replaces the credential.
    let onPairAgain: () -> Void

    @State private var isRenewing = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label {
                Text(message)
                    .foregroundStyle(T3Colors.textPrimary)
            } icon: {
                Image(systemName: "lock.shield")
                    .foregroundStyle(T3Colors.warning)
            }
            SettingsActionButton(
                title: update == .pairAgain ? "Pair Again" : "Renew Access",
                systemImage: update == .pairAgain ? "qrcode.viewfinder" : "arrow.clockwise",
                tone: .primary,
                isBusy: isRenewing,
                action: act
            )
            if let error {
                SettingsFooter(error: error)
                    .font(T3Typography.supporting)
            }
        }
        .padding(.vertical, 4)
    }

    private var message: String {
        let device = UIDevice.current.model
        return update == .pairAgain
            ? "New permissions available. Pair this \(device) again to keep Files, Git and settings working."
            : "New permissions available. Renew this \(device)'s T3 Connect access to keep Files, Git and settings working."
    }

    private func act() {
        if update == .pairAgain {
            onPairAgain()
            return
        }
        isRenewing = true
        error = nil
        Task {
            do {
                try await model.renewEnvironmentAccess(environmentID)
            } catch {
                self.error = "Couldn't renew access. \(error.localizedDescription)"
                PlatformHapticEngine.shared.play(.error)
            }
            isRenewing = false
        }
    }
}

/// The merge method this server's pull requests start with, unless a project
/// sets its own. "Last Used" leaves it to the method last chosen on each device.
private struct SettingsMergeMethodPicker: View {
    let environmentID: String
    let saved: String?
    let manager: any FeatureServerSettingsManaging
    @Binding var error: String?
    /// The value just picked, shown until the server's answer replaces it.
    @State private var pending: String?? = nil

    init(environmentID: String, saved: String?, manager: any FeatureServerSettingsManaging, error: Binding<String?>) {
        self.environmentID = environmentID
        self.saved = saved
        self.manager = manager
        _error = error
    }

    var body: some View {
        Picker(selection: Binding(get: { pending ?? saved }, set: write)) {
            Text("Last Used").tag(String?.none)
            ForEach(["merge", "squash", "rebase"], id: \.self) { method in
                Text(PullRequestActionLogic.methodLabel(method)).tag(Optional(method))
            }
        } label: {
            SettingsTileLabel(title: "Default Merge Method", systemImage: "arrow.triangle.merge", tint: .purple)
        }
        .pickerStyle(.menu)
        .accessibilityHint("The merge method pull requests on this server start with")
    }

    private func write(_ method: String?) {
        guard method != (pending ?? saved) else { return }
        pending = .some(method)
        error = nil
        Task {
            do {
                try await manager.updateServerSettings(environmentID: environmentID,
                    patch: ServerSettingsPatchInput(pullRequestMergeMethod: .some(method)))
            } catch {
                self.error = "Couldn't save the merge method. \(error.localizedDescription)"
                PlatformHapticEngine.shared.play(.error)
            }
            pending = nil
        }
    }
}
