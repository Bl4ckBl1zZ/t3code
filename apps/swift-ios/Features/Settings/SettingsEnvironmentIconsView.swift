import SwiftUI

struct SettingsEnvironmentIconsView: View {
    @Bindable var model: FeatureRootModel
    @State private var environmentID = ""
    @State private var selected = "automatic"
    @State private var loading = false
    @State private var pending = false
    @State private var errorMessage: String?

    private var manager: any FeatureServerSettingsManaging {
        (model.client as? any FeatureServerSettingsManaging) ?? EmptyFeatureServerSettingsManager.shared
    }
    private var environment: FeatureEnvironment? { model.snapshot.environments.first { $0.id == environmentID } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Picker("Environment", selection: $environmentID) {
                    ForEach(model.snapshot.environments) { environment in
                        Label(environment.name, systemImage: environment.machineSymbol).tag(environment.id)
                    }
                }.disabled(pending)
                Text("The icon is saved on this environment and appears on every connected client. Automatic uses the detected machine type.")
                    .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                if let errorMessage { SettingsErrorBanner(message: errorMessage) }
                if loading { ProgressView().frame(maxWidth: .infinity) }
                if environment?.supportsEnvironmentIcon != true {
                    Text("Connect a current server to change its icon.")
                        .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                }
                ThreadDetailsSection(title: "Machine icon") {
                    iconRow(value: "automatic", label: "Automatic", symbol: "sparkles")
                    ForEach(EnvironmentMachineKind.allCases, id: \.rawValue) { kind in
                        iconRow(value: kind.rawValue, label: kind.label, symbol: kind.symbol)
                    }
                }
                .disabled(loading || pending || environment?.supportsEnvironmentIcon != true)
                if pending { ProgressView("Saving icon…").font(T3Typography.supporting) }
            }.padding(18)
        }
        .background(T3Colors.background)
        .navigationTitle("Environment icons")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { if environmentID.isEmpty { environmentID = model.snapshot.environments.first(where: \.isActive)?.id ?? model.snapshot.environments.first?.id ?? "" } }
        .task(id: environmentID) { await load() }
    }

    private func iconRow(value: String, label: String, symbol: String) -> some View {
        Button { Task { await save(value) } } label: {
            HStack(spacing: 12) {
                Image(systemName: symbol).frame(width: 24)
                Text(label)
                Spacer()
                if selected == value { Image(systemName: "checkmark").foregroundStyle(T3Colors.accent) }
            }
            .font(T3Typography.supportingStrong).foregroundStyle(T3Colors.textPrimary)
            .padding(14).frame(minHeight: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityAddTraits(selected == value ? .isSelected : [])
    }

    private func load() async {
        let requestedID = environmentID
        guard !requestedID.isEmpty else { return }
        loading = true
        errorMessage = nil
        do {
            let config = try await manager.providerModelConfiguration(environmentID: requestedID)
            guard !Task.isCancelled, environmentID == requestedID else { return }
            selected = config.settings?.environmentIcon.flatMap(EnvironmentMachineKind.init(rawValue:))?.rawValue ?? "automatic"
        } catch {
            guard !Task.isCancelled, environmentID == requestedID else { return }
            errorMessage = error.localizedDescription
        }
        loading = false
    }

    private func save(_ value: String) async {
        guard !pending, value != selected else { return }
        let requestedID = environmentID
        pending = true
        errorMessage = nil
        do {
            _ = try await manager.updateServerSettings(environmentID: requestedID,
                patch: ServerSettingsPatchInput(environmentIcon: .some(value == "automatic" ? nil : value)))
            if environmentID == requestedID { selected = value }
        } catch { errorMessage = error.localizedDescription }
        pending = false
    }
}
