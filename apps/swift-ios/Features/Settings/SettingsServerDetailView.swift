import SwiftUI

/// One saved server: whether this device connects to it, and the way to
/// remove it. Pushed from the info button on a Servers row.
struct SettingsServerDetailView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel
    let environmentID: String

    @State private var pendingEnabled: Bool?
    @State private var confirmingRemoval = false

    private var environment: FeatureEnvironment? {
        (model.snapshot.environments + model.snapshot.switchedOffEnvironments)
            .first { $0.id == environmentID }
    }

    var body: some View {
        SettingsForm {
            if let environment {
                content(environment)
            }
        }
        .navigationTitle(environment?.name ?? "Server")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: environment == nil) { _, removed in
            if removed { dismiss() }
        }
    }

    @ViewBuilder
    private func content(_ environment: FeatureEnvironment) -> some View {
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
