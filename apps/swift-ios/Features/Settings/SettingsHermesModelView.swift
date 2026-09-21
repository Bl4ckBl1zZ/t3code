import SwiftUI
import UIKit

/// Connects Hermes to a model account and picks the model it runs.
struct SettingsHermesModelView: View {
    let manager: any FeatureWorkManaging
    let environmentID: String
    let instanceID: String
    var onConnected: () -> Void = {}
    @State private var status: HermesWorkModelStatus?
    @State private var flow: HermesWorkModelAuthStart?
    @State private var flowProvider = ""
    @State private var provider = ""
    @State private var model = ""
    @State private var savedModel = ""
    @State private var busy = false
    @State private var reloading = false
    @State private var loadError: String?
    @State private var errorMessage: String?
    @State private var authMessage: String?
    @State private var costMessage: String?
    @State private var confirmExpensive = false
    @State private var expiresAt: Date?
    private var scope: [String: JSONValue] { ["providerInstanceId": .string(instanceID)] }

    var body: some View {
        content
            .navigationTitle("Model Account")
            .navigationBarTitleDisplayMode(.inline)
            .task { await reload() }
            .task(id: flow?.sessionId) { await poll() }
            .confirmationDialog("Use this model?", isPresented: $confirmExpensive, titleVisibility: .visible) {
                Button("Use Model") { saveModel(confirmed: true) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(costMessage ?? "Hermes asks you to confirm this model’s cost before selecting it.")
            }
    }

    @ViewBuilder
    private var content: some View {
        if status == nil, let loadError, !reloading {
            ContentUnavailableView {
                Label("Couldn't Load Accounts", systemImage: "exclamationmark.triangle")
            } description: {
                Text(loadError)
            } actions: {
                Button("Try Again") { Task { await reload() } }
            }
            .background(T3Colors.background)
        } else {
            SettingsForm {
                if let status {
                    accountsSection(status)
                    if let flow { signInSection(flow) }
                    modelSection(status)
                } else {
                    Section { SettingsPlaceholderRows(count: 3) }
                }
            }
            .refreshable { await reload() }
        }
    }

    private func accountsSection(_ status: HermesWorkModelStatus) -> some View {
        Section {
            ForEach(status.accounts) { account in
                LabeledContent(account.name) {
                    if account.loggedIn {
                        Text(account.sourceLabel ?? "Connected").foregroundStyle(T3Colors.success)
                    } else if account.flow == "device_code" {
                        Button("Connect") { start(account.id) }
                            .buttonStyle(.bordered)
                            .disabled(busy || flow != nil)
                    } else {
                        Text("Not Connected")
                    }
                }
            }
        } header: {
            Text("Accounts")
        } footer: {
            let needsHermes = status.accounts.contains { !$0.loggedIn && $0.flow != "device_code" }
            SettingsFooter(
                text: flow == nil
                    ? [authMessage, needsHermes ? "Connect other accounts in Hermes, then pull to refresh." : nil]
                        .compactMap { $0 }.joined(separator: "\n").nilIfEmpty
                    : nil,
                error: flow == nil ? errorMessage : nil
            )
        }
    }

    private func signInSection(_ flow: HermesWorkModelAuthStart) -> some View {
        Section {
            VStack(spacing: 14) {
                Text(flow.userCode)
                    .font(.system(.title, design: .monospaced).weight(.semibold))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity)
                HStack(spacing: 10) {
                    Button {
                        UIPasteboard.general.string = flow.userCode
                        PlatformHapticEngine.shared.play(.success)
                    } label: {
                        Text("Copy Code").frame(maxWidth: .infinity)
                    }
                    .t3SecondaryButtonStyle()
                    if let url = URL(string: flow.verificationUrl), url.scheme == "https" {
                        Link(destination: url) {
                            Text("Open Sign-In").frame(maxWidth: .infinity)
                        }
                        .t3ProminentButtonStyle()
                    }
                }
                .controlSize(.large)
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Waiting for sign-in…").foregroundStyle(T3Colors.textSecondary)
                }
            }
            .padding(.vertical, 6)
            Button("Cancel Sign-In", role: .destructive) { cancel() }
                .disabled(busy)
        } header: {
            Text("Complete Sign-In")
        } footer: {
            SettingsFooter(
                text: expiresAt.map { "Enter the code on the sign-in page. It expires at \($0.formatted(date: .omitted, time: .shortened))." },
                error: errorMessage
            )
        }
    }

    @ViewBuilder
    private func modelSection(_ status: HermesWorkModelStatus) -> some View {
        let providers = status.providers.filter(\.authenticated)
        let models = providers.first(where: { $0.id == provider })?.models ?? []
        Section {
            Picker("Provider", selection: Binding(get: { provider }, set: { provider = $0; model = "" })) {
                if provider.isEmpty || !providers.contains(where: { $0.id == provider }) {
                    Text("Choose").tag(provider)
                }
                ForEach(providers) { Text($0.name).tag($0.id) }
            }
            .pickerStyle(.menu)
            NavigationLink {
                HermesModelList(models: models, selection: $model)
            } label: {
                LabeledContent("Model", value: model.isEmpty ? "Choose" : model)
            }
            .disabled(provider.isEmpty)
            Button {
                saveModel()
            } label: {
                HStack {
                    Text(model == savedModel && !model.isEmpty ? "Model in Use" : "Use This Model")
                    Spacer()
                    if busy, flow == nil {
                        ProgressView()
                    } else if model == savedModel, !model.isEmpty {
                        Image(systemName: "checkmark").foregroundStyle(T3Colors.accent)
                    }
                }
            }
            .disabled(busy || provider.isEmpty || model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model == savedModel)
        } header: {
            Text("Default Model")
        } footer: {
            Text("Hermes needs a connected account for the model's provider. Connecting does not send a paid test prompt.")
        }
    }

    private func reload() async {
        guard !reloading else { return }
        reloading = true
        defer { reloading = false }
        do {
            let next = try await manager.workModelStatus(environmentID: environmentID, input: .object(scope))
            try Task.checkCancellation()
            status = next
            savedModel = next.model
            if provider.isEmpty { provider = next.provider; model = next.model }
            loadError = nil
        } catch {
            if !Task.isCancelled { loadError = error.localizedDescription }
        }
    }

    private func start(_ account: String) {
        busy = true
        errorMessage = nil
        authMessage = nil
        Task {
            defer { busy = false }
            do {
                var input = scope
                input["provider"] = .string(account)
                let next = try await manager.workModelAuthStart(environmentID: environmentID, input: .object(input))
                flowProvider = account
                expiresAt = .now.addingTimeInterval(next.expiresIn)
                flow = next
            } catch {
                PlatformHapticEngine.shared.play(.error)
                errorMessage = error.localizedDescription
            }
        }
    }

    private func poll() async {
        guard let active = flow else { return }
        do {
            while !Task.isCancelled {
                var input = scope
                input["provider"] = .string(flowProvider)
                input["sessionId"] = .string(active.sessionId)
                let next = try await manager.workModelAuthPoll(environmentID: environmentID, input: .object(input))
                try Task.checkCancellation()
                guard next.status == "pending" else {
                    if next.status == "approved" {
                        PlatformHapticEngine.shared.play(.success)
                    } else {
                        PlatformHapticEngine.shared.play(.warning)
                    }
                    authMessage = next.message ?? (next.status == "approved" ? "Account connected. Choose a model below." : "Sign-in \(next.status).")
                    flow = nil
                    await reload()
                    return
                }
                if let expiresAt, expiresAt <= .now {
                    flow = nil
                    authMessage = "Sign-in expired. Start again to get a new code."
                    return
                }
                try await Task.sleep(for: .seconds(max(1, active.pollInterval)))
            }
        } catch {
            if !Task.isCancelled {
                flow = nil
                errorMessage = error.localizedDescription
            }
        }
    }

    private func cancel() {
        guard let active = flow else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                var input = scope
                input["sessionId"] = .string(active.sessionId)
                _ = try await manager.workModelAuthCancel(environmentID: environmentID, input: .object(input))
                flow = nil
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func saveModel(confirmed: Bool = false) {
        busy = true
        errorMessage = nil
        Task {
            defer { busy = false }
            do {
                var input = scope
                input["provider"] = .string(provider)
                input["model"] = .string(model)
                input["confirmExpensiveModel"] = .bool(confirmed)
                let result = try await manager.workModelSet(environmentID: environmentID, input: .object(input))
                if result.confirmRequired {
                    costMessage = result.message
                    confirmExpensive = true
                } else if result.ok {
                    PlatformHapticEngine.shared.play(.success)
                    savedModel = model
                    onConnected()
                    await reload()
                } else {
                    PlatformHapticEngine.shared.play(.error)
                    errorMessage = result.message ?? "The model could not be selected."
                }
            } catch {
                PlatformHapticEngine.shared.play(.error)
                errorMessage = error.localizedDescription
            }
        }
    }
}

/// The provider's models as a checkmark list, ending in "Other…" for an ID
/// the provider does not list.
private struct HermesModelList: View {
    let models: [String]
    @Binding var selection: String
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var other = ""

    var body: some View {
        SettingsForm {
            if !models.isEmpty {
                Section {
                    ForEach(models, id: \.self) { model in
                        Button {
                            selection = model
                            PlatformHapticEngine.shared.playSelection()
                            dismiss()
                        } label: {
                            HStack {
                                Text(model).foregroundStyle(T3Colors.textPrimary)
                                Spacer()
                                if model == selection {
                                    Image(systemName: "checkmark").foregroundStyle(T3Colors.accent)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                    }
                }
            }
            Section {
                TextField("Model ID", text: $other)
                    .font(.system(.body, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit(useOther)
                Button("Use This ID", action: useOther)
                    .disabled(other.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } header: {
                Text("Other")
            } footer: {
                Text("Any model ID this provider accepts.")
            }
        }
        .navigationTitle("Model")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if !selection.isEmpty, !models.contains(selection) { other = selection }
        }
    }

    private func useOther() {
        let trimmed = other.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        selection = trimmed
        dismiss()
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
