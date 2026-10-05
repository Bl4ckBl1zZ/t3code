import SwiftUI
import UIKit

/// One saved server: whether this device connects to it, the routes it is
/// reached over, and the way to remove it. Pushed from the info button on a
/// Servers row.
struct SettingsServerDetailView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel
    let environmentID: String

    @State private var pendingEnabled: Bool?
    @State private var confirmingRemoval = false
    @State private var routeInUse: String?
    @State private var routeToRemove: FeatureEnvironmentRoute?
    @State private var addingRoute = false

    private var environment: FeatureEnvironment? {
        (model.snapshot.environments + model.snapshot.switchedOffEnvironments)
            .first { $0.id == environmentID }
    }

    /// Changes when the route in use may have: the routes or the connection.
    private var routeRefreshKey: String {
        let ids = environment?.routes.map(\.id).joined(separator: ",") ?? ""
        let state = environment?.connectionState?.rawValue ?? ""
        return "\(ids)|\(model.snapshot.connection.state.rawValue)|\(state)"
    }

    var body: some View {
        SettingsForm {
            if let environment {
                content(environment)
            }
        }
        .navigationTitle(environment?.name ?? "Server")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if (environment?.routes.count ?? 0) > 1 {
                ToolbarItem(placement: .primaryAction) { EditButton() }
            }
        }
        .onChange(of: environment == nil) { _, removed in
            if removed { dismiss() }
        }
        .task(id: routeRefreshKey) {
            routeInUse = await model.environmentRouteInUse(environmentID)
        }
        .sheet(isPresented: $addingRoute) {
            SettingsAddRouteSheet(
                serverName: environment?.name ?? "this server",
                onAdd: { url in await model.addEnvironmentRoute(environmentID, pairingURL: url) }
            )
        }
    }

    @ViewBuilder
    private func content(_ environment: FeatureEnvironment) -> some View {
        if let reason = environment.unsupportedReason {
            compatibilitySection(environment, reason: reason)
        }

        Section {
            Toggle(isOn: enabledBinding(environment)) {
                SettingsTileLabel(
                    title: "Connect on This Device",
                    systemImage: "power",
                    tint: environment.isEnabled ? .green : .gray
                )
            }
            .disabled(pendingEnabled != nil)
        } footer: {
            Text(environment.isEnabled
                ? "Switch a server off to stop connecting to it without forgetting it. Its threads leave Home until you switch it back on."
                : "This server stays saved with its credentials but doesn't connect or appear in Home.")
        }

        routesSection(environment)

        if !environment.isActive {
            Section {
                Button("Remove Server", role: .destructive) { confirmingRemoval = true }
                    .foregroundStyle(T3Colors.danger)
                    .confirmationDialog(
                        "Remove \(environment.name)?",
                        isPresented: $confirmingRemoval,
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
        }
    }

    /// Why the server is switched off for an incompatible version, and the
    /// way out: an in-app update for a desktop-hosted server, otherwise
    /// switching it back on after updating by hand.
    @ViewBuilder
    private func compatibilitySection(_ environment: FeatureEnvironment, reason: String) -> some View {
        let stage = model.serverUpdateStages[environment.id]
        Section {
            Label {
                Text(reason)
                    .foregroundStyle(T3Colors.textPrimary)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(T3Colors.warning)
            }
            if environment.serverUpdateRequired {
                Button {
                    Task { await model.updateOutdatedEnvironment(environment.id) }
                } label: {
                    HStack {
                        Text(stage.map(Self.updateStageTitle) ?? "Update Server")
                        Spacer()
                        if stage != nil {
                            ProgressView()
                        }
                    }
                }
                .disabled(stage != nil)
            }
        } header: {
            Text("Not Supported")
        } footer: {
            Text(environment.serverUpdateRequired
                ? "T3 Code on \(environment.name) updates and restarts, then this server switches back on."
                : "After updating, switch this server back on to check again.")
        }
    }

    private static func updateStageTitle(_ stage: String) -> String {
        switch stage {
        case "downloading": "Downloading Update…"
        case "installing": "Installing Update…"
        case "resuming": "Restarting Server…"
        case "restarting": "Waiting for Server…"
        default: "Updating Server…"
        }
    }

    /// The ways this device reaches the server, preferred first. The first
    /// that answers is used, and the connection moves back up when a better
    /// one is reachable again.
    @ViewBuilder
    private func routesSection(_ environment: FeatureEnvironment) -> some View {
        Section {
            ForEach(environment.routes) { route in
                routeRow(route, inUse: environment.isEnabled && route.id == routeInUse)
                    .swipeActions(edge: .trailing) {
                        // The last route goes with the server, and a learned
                        // route would only be learned again.
                        if environment.routes.count > 1, !route.isLearned {
                            Button("Remove", role: .destructive) { routeToRemove = route }
                        }
                    }
            }
            .onMove { source, destination in
                var ids = environment.routes.map(\.id)
                ids.move(fromOffsets: source, toOffset: destination)
                Task { await model.reorderEnvironmentRoutes(environment.id, routeIDs: ids) }
            }
            Button {
                addingRoute = true
            } label: {
                Label("Add Route", systemImage: "plus")
            }
        } header: {
            Text("Routes")
        } footer: {
            Text("The first route that answers is used. Learned addresses were reported by the server while connected; they follow its network and can be reordered but not removed.")
        }
        .confirmationDialog(
            "Remove \(routeToRemove?.label ?? "route")?",
            isPresented: Binding(
                get: { routeToRemove != nil },
                set: { if !$0 { routeToRemove = nil } }
            ),
            titleVisibility: .visible,
            presenting: routeToRemove
        ) { route in
            Button("Remove Route", role: .destructive) {
                Task { await model.removeEnvironmentRoute(environment.id, routeID: route.id) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { route in
            Text("\(route.address ?? route.label) will need pairing again to be added back. Its credential is forgotten on this device.")
        }
    }

    private func routeRow(_ route: FeatureEnvironmentRoute, inUse: Bool) -> some View {
        HStack(spacing: 12) {
            T3SettingsTile(route.systemImage, tint: route.isRelay ? .teal : .blue)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(route.label)
                        .foregroundStyle(T3Colors.textPrimary)
                    if inUse {
                        Text("In use")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.success)
                    }
                }
                if let address = route.address {
                    Text(route.isLearned ? "\(address) · found automatically" : address)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func enabledBinding(_ environment: FeatureEnvironment) -> Binding<Bool> {
        Binding(
            get: { pendingEnabled ?? environment.isEnabled },
            set: { enabled in
                guard pendingEnabled == nil, enabled != environment.isEnabled else { return }
                pendingEnabled = enabled
                PlatformHapticEngine.shared.playSelection()
                Task {
                    await model.setEnvironmentEnabled(environment.id, enabled: enabled)
                    pendingEnabled = nil
                }
            }
        )
    }
}

/// Pairs the same machine at another address: paste the pairing link the
/// machine shows for that address. A link for a different machine is refused.
private struct SettingsAddRouteSheet: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let serverName: String
    let onAdd: (String) async -> Bool

    @State private var link = ""
    @State private var isAdding = false

    var body: some View {
        NavigationStack {
            SettingsForm {
                Section {
                    TextField("Pairing link", text: $link, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    Button("Paste") {
                        if let pasted = UIPasteboard.general.string { link = pasted }
                    }
                } footer: {
                    Text("Create a pairing link on \(serverName) for the address you want to add, such as its LAN or Tailscale address, and paste it here.")
                }
            }
            .navigationTitle("Add Route")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        isAdding = true
                        Task {
                            let added = await onAdd(link.trimmingCharacters(in: .whitespacesAndNewlines))
                            isAdding = false
                            if added { dismiss() }
                        }
                    }
                    .disabled(isAdding || link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
