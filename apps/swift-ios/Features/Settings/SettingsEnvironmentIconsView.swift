import SwiftUI

/// The icon a server shows on every connected client. The choice applies as it
/// is tapped; a failed write moves the checkmark back.
struct SettingsEnvironmentIconsView: View {
    private static let automatic = "automatic"

    @Bindable var model: FeatureRootModel
    @State private var environmentID = ""
    /// The server's stored choice. `nil` until it answers, so no row is checked
    /// before anyone knows which one is.
    @State private var saved: String?
    /// The tapped choice while its write is in flight.
    @State private var pending: String?
    @State private var loadError: String?
    @State private var failure: String?

    private var manager: any FeatureServerSettingsManaging {
        (model.client as? any FeatureServerSettingsManaging) ?? EmptyFeatureServerSettingsManager.shared
    }

    private var environment: FeatureEnvironment? {
        model.snapshot.environments.first { $0.id == environmentID }
    }

    private var supported: Bool { environment?.supportsEnvironmentIcon == true }
    private var selected: String? { pending ?? saved }

    /// What Automatic currently resolves to, shown beside it while it is the
    /// choice. Once another icon is chosen the detected kind is not known here.
    private var automaticValue: String? {
        guard selected == Self.automatic else { return nil }
        return environment?.machineKind.flatMap(EnvironmentMachineKind.init(rawValue:))?.label
    }

    var body: some View {
        SettingsForm {
            if let loadError, saved == nil {
                SettingsRetrySection(message: loadError) { Task { await load() } }
            } else {
                rows
            }
        }
        .settingsServerScope(
            title: "Environment Icon",
            environments: model.snapshot.environments,
            selection: $environmentID,
            isEnabled: pending == nil
        )
        .onAppear {
            if environmentID.isEmpty {
                environmentID = model.snapshot.environments.first(where: \.isActive)?.id
                    ?? model.snapshot.environments.first?.id ?? ""
            }
        }
        .task(id: environmentID) { await load() }
        .alert(
            "Couldn't Change Icon",
            isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
        ) {
            Button("OK") { failure = nil }
        } message: {
            Text(failure ?? "")
        }
    }

    @ViewBuilder
    private var rows: some View {
        Section {
            row(value: Self.automatic, label: "Automatic", symbol: "sparkles", detail: automaticValue)
        } footer: {
            Text("Uses the detected machine type.")
        }
        .disabled(!supported || saved == nil)
        Section {
            ForEach(EnvironmentMachineKind.allCases, id: \.rawValue) { kind in
                row(value: kind.rawValue, label: kind.label, symbol: kind.symbol, detail: nil)
            }
        } footer: {
            if environment != nil, !supported {
                Text("Connect a current server to change its icon.")
            } else if let environment {
                Text("Shown for \(environment.name) on every connected client.")
            }
        }
        .disabled(!supported || saved == nil)
    }

    private func row(value: String, label: String, symbol: String, detail: String?) -> some View {
        let isSelected = selected == value
        return Button { select(value) } label: {
            HStack(spacing: 12) {
                Label(label, systemImage: symbol)
                    .foregroundStyle(T3Colors.textPrimary)
                Spacer(minLength: 8)
                if let detail {
                    Text(detail).foregroundStyle(T3Colors.textSecondary)
                }
                Image(systemName: "checkmark")
                    .fontWeight(.semibold)
                    .foregroundStyle(T3Colors.accent)
                    .opacity(isSelected ? 1 : 0)
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func load() async {
        let requestedID = environmentID
        guard !requestedID.isEmpty else { return }
        saved = nil
        pending = nil
        loadError = nil
        do {
            let config = try await manager.providerModelConfiguration(environmentID: requestedID)
            guard !Task.isCancelled, environmentID == requestedID else { return }
            saved = config.settings?.environmentIcon
                .flatMap(EnvironmentMachineKind.init(rawValue:))?.rawValue ?? Self.automatic
        } catch {
            guard !Task.isCancelled, environmentID == requestedID else { return }
            loadError = error.localizedDescription
        }
    }

    private func select(_ value: String) {
        guard pending == nil, value != saved else { return }
        let requestedID = environmentID
        pending = value
        PlatformHapticEngine.shared.playSelection()
        Task { @MainActor in
            do {
                _ = try await manager.updateServerSettings(
                    environmentID: requestedID,
                    patch: ServerSettingsPatchInput(environmentIcon: .some(value == Self.automatic ? nil : value))
                )
                if environmentID == requestedID { saved = value }
            } catch {
                if environmentID == requestedID {
                    PlatformHapticEngine.shared.play(.error)
                    failure = error.localizedDescription
                }
            }
            if environmentID == requestedID { pending = nil }
        }
    }
}
