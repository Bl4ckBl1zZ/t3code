import SwiftUI

struct SettingsLoadBalancingView: View {
    @Bindable var model: FeatureRootModel
    @AppStorage(NativeLoadBalancingPreferences.enabledKey) private var enabled = false
    @AppStorage(NativeLoadBalancingPreferences.weightsKey) private var weightsJSON = "{}"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Choose a machine for new tasks using available CPU and memory. Only connected machines with the same repository and selected agent model are eligible. These preferences apply on this device.")
                    .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                ThreadDetailsSection(title: "Automatic selection") {
                    Toggle("Balance new tasks", isOn: $enabled).padding(14)
                    Text("You can choose a machine manually in New Task. Branch choices and attachments keep work on the selected machine.")
                        .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).padding(14)
                }
                if model.snapshot.environments.count < 2 {
                    Text("Connect another machine to balance tasks between them.")
                        .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                }
                ThreadDetailsSection(title: "Machine preferences") {
                    ForEach(model.snapshot.environments) { environment in
                        Picker(selection: weightBinding(environment.id)) {
                            Text("Prefer").tag(100.0)
                            Text("Normal").tag(50.0)
                            Text("Less often").tag(25.0)
                            Text("Manual only").tag(0.0)
                            let value = NativeLoadBalancingPreferences.weights(from: weightsJSON)[environment.id] ?? 50
                            if ![0.0, 25, 50, 100].contains(value) {
                                Text("Custom (\(value.formatted()))").tag(value)
                            }
                        } label: {
                            Label(environment.name, systemImage: environment.machineSymbol)
                        }.padding(14)
                    }
                }.disabled(!enabled)
            }.padding(18)
        }
        .background(T3Colors.background)
        .navigationTitle("Load balancing")
        .navigationBarTitleDisplayMode(.inline)
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
