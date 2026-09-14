import SwiftUI
import UIKit

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
    @State private var busy = false
    @State private var reloading = false
    @State private var errorMessage: String?
    @State private var authMessage: String?
    @State private var confirmExpensive = false
    @State private var expiresAt: Date?
    private var scope: [String: JSONValue] { ["providerInstanceId": .string(instanceID)] }

    var body: some View {
        Form {
            if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
            if let status {
                Section("Model account") {
                    ForEach(status.accounts) { account in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(account.name).font(.headline)
                            if account.loggedIn { Text(account.sourceLabel ?? "Connected").font(.caption) }
                            else if account.flow == "device_code" {
                                Button("Connect \(account.name)") { start(account.id) }.disabled(busy || flow != nil)
                            } else {
                                Text("Connect this account in Hermes, then refresh here.").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if let flow {
                    Section("Complete sign-in") {
                        Text(flow.userCode).font(.title.monospaced()).textSelection(.enabled)
                        Button("Copy code") { UIPasteboard.general.string = flow.userCode }
                        if let url = URL(string: flow.verificationUrl), url.scheme == "https" {
                            Link("Open sign-in page", destination: url)
                        }
                        if let expiresAt { Text("Expires \(expiresAt.formatted(date: .omitted, time: .shortened))").font(.caption) }
                        ProgressView("Waiting for sign-in…")
                        Button("Cancel sign-in") { cancel() }.disabled(busy)
                    }
                }
                if let authMessage { Text(authMessage).font(.callout) }
                Section("Default model") {
                    Picker("Provider", selection: Binding(get: { provider }, set: { provider = $0; model = "" })) {
                        Text("Choose a provider").tag("")
                        ForEach(status.providers.filter(\.authenticated)) { Text($0.name).tag($0.id) }
                    }
                    let models = status.providers.first(where: { $0.id == provider })?.models ?? []
                    if !models.isEmpty {
                        Picker("Available models", selection: $model) {
                            Text("Choose a model").tag("")
                            if !model.isEmpty && !models.contains(model) { Text(model).tag(model) }
                            ForEach(models, id: \.self) { Text($0).tag($0) }
                        }
                    }
                    TextField("Model", text: $model).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Use this model") { saveModel() }.disabled(busy || provider.isEmpty || model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Text("Hermes must have an authenticated account for this model provider. Connecting does not send a paid test prompt.").font(.caption).foregroundStyle(.secondary)
                }
            } else if errorMessage == nil { ProgressView("Loading model accounts…") }
            Button("Refresh accounts") { Task { await reload() } }.disabled(busy || reloading)
        }
        .navigationTitle("Connect a model")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .task(id: flow?.sessionId) { await poll() }
        .confirmationDialog("Use this model?", isPresented: $confirmExpensive) {
            Button("Use model") { saveModel(confirmed: true) }
        } message: { Text(errorMessage ?? "Hermes asks you to confirm this model’s cost before selecting it.") }
    }
    private func reload() async {
        guard !reloading else { return }
        reloading = true
        defer { reloading = false }
        do {
            let next = try await manager.workModelStatus(environmentID: environmentID, input: .object(scope))
            try Task.checkCancellation()
            status = next
            if provider.isEmpty { provider = next.provider; model = next.model }
            errorMessage = nil
        } catch { if !Task.isCancelled { errorMessage = error.localizedDescription } }
    }
    private func start(_ account: String) {
        busy = true; errorMessage = nil; authMessage = nil
        Task {
            defer { busy = false }
            do {
                var input = scope; input["provider"] = .string(account)
                let next = try await manager.workModelAuthStart(environmentID: environmentID, input: .object(input))
                flowProvider = account; expiresAt = .now.addingTimeInterval(next.expiresIn); flow = next
            } catch { errorMessage = error.localizedDescription }
        }
    }
    private func poll() async {
        guard let active = flow else { return }
        do {
            while !Task.isCancelled {
                var input = scope; input["provider"] = .string(flowProvider); input["sessionId"] = .string(active.sessionId)
                let next = try await manager.workModelAuthPoll(environmentID: environmentID, input: .object(input))
                try Task.checkCancellation()
                guard next.status == "pending" else {
                    authMessage = next.message ?? (next.status == "approved" ? "Account connected. Choose a model below." : "Sign-in \(next.status).")
                    flow = nil; await reload(); return
                }
                if let expiresAt, expiresAt <= .now { flow = nil; authMessage = "Sign-in expired. Start again to get a new code."; return }
                try await Task.sleep(for: .seconds(max(1, active.pollInterval)))
            }
        } catch { if !Task.isCancelled { flow = nil; errorMessage = error.localizedDescription } }
    }
    private func cancel() {
        guard let active = flow else { return }
        busy = true
        Task {
            defer { busy = false }
            do { var input = scope; input["sessionId"] = .string(active.sessionId); _ = try await manager.workModelAuthCancel(environmentID: environmentID, input: .object(input)); flow = nil }
            catch { errorMessage = error.localizedDescription }
        }
    }
    private func saveModel(confirmed: Bool = false) {
        busy = true; errorMessage = nil
        Task {
            defer { busy = false }
            do {
                var input = scope; input["provider"] = .string(provider); input["model"] = .string(model); input["confirmExpensiveModel"] = .bool(confirmed)
                let result = try await manager.workModelSet(environmentID: environmentID, input: .object(input))
                if result.confirmRequired { errorMessage = result.message; confirmExpensive = true }
                else if result.ok { authMessage = "Model selected."; onConnected(); await reload() }
                else { errorMessage = result.message ?? "The model could not be selected." }
            } catch { errorMessage = error.localizedDescription }
        }
    }
}
