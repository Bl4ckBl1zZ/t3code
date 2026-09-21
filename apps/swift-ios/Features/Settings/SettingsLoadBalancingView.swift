import SwiftUI

/// Whether New Task picks a machine by available CPU and memory, and how much
/// each machine is preferred. Stored on this device.
struct SettingsLoadBalancingView: View {
    @Bindable var model: FeatureRootModel
    let onAddServer: () -> Void
    @AppStorage(NativeLoadBalancingPreferences.enabledKey) private var enabled = false
    @AppStorage(NativeLoadBalancingPreferences.weightsKey) private var weightsJSON = "{}"

    private var environments: [FeatureEnvironment] { model.snapshot.environments }

    var body: some View {
        Group {
            if environments.count < 2 {
                ContentUnavailableView {
                    Label(
                        environments.isEmpty ? "No Machines Connected" : "One Machine Connected",
                        systemImage: "scalemass"
                    )
                } description: {
                    Text("Connect another machine to balance new tasks between them.")
                } actions: {
                    Button("Connect a Server", action: onAddServer)
                        .t3ProminentButtonStyle()
                }
                .background(T3Colors.background)
            } else {
                SettingsForm {
                    Section {
                        Toggle("Balance New Tasks", isOn: $enabled)
                    } footer: {
                        Text("Picks a machine for each new task by available CPU and memory. Only connected machines with the same repository and agent model are eligible. Applies on this device.")
                    }

                    if enabled {
                        Section {
                            ForEach(environments) { environment in
                                machinePicker(environment)
                            }
                        } header: {
                            Text("Machines")
                        } footer: {
                            Text("You can still pick a machine in New Task. Branch choices and attachments keep work on the selected machine.")
                        }
                    }
                }
            }
        }
        .navigationTitle("Load Balancing")
        .navigationBarTitleDisplayMode(.inline)
        .t3SensoryFeedback(.selection, trigger: enabled)
    }

    /// A labelled menu picker. Inside a Form the label renders, which is what
    /// puts each machine's name beside its weight.
    private func machinePicker(_ environment: FeatureEnvironment) -> some View {
        let value = NativeLoadBalancingPreferences.weights(from: weightsJSON)[environment.id] ?? 50
        return Picker(selection: weightBinding(environment.id)) {
            Text("Prefer").tag(100.0)
            Text("Normal").tag(50.0)
            Text("Less Often").tag(25.0)
            Text("Manual Only").tag(0.0)
            if ![0.0, 25, 50, 100].contains(value) {
                Text("Custom (\(value.formatted()))").tag(value)
            }
        } label: {
            Label {
                Text(environment.name)
            } icon: {
                T3SettingsTile(environment.machineSymbol, tint: environment.isActive ? .ink : .gray)
            }
        }
        .pickerStyle(.menu)
    }

    private func weightBinding(_ id: String) -> Binding<Double> {
        Binding(
            get: { NativeLoadBalancingPreferences.weights(from: weightsJSON)[id] ?? 50 },
            set: { value in
                var weights = NativeLoadBalancingPreferences.weights(from: weightsJSON)
                weights[id] = value
                weightsJSON = NativeLoadBalancingPreferences.encoding(weights)
            }
        )
    }
}
