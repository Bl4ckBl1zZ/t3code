import SwiftUI

struct SettingsModelPricesView: View {
    @Bindable var model: FeatureRootModel
    @State private var environmentID = ""
    @State private var prices: [String: UsageModelPriceOverride]?
    @State private var loading = false
    @State private var errorMessage: String?
    @State private var draft: PriceDraft?

    private var manager: any FeatureServerSettingsManaging {
        (model.client as? any FeatureServerSettingsManaging) ?? EmptyFeatureServerSettingsManager.shared
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Picker("Environment", selection: $environmentID) {
                    ForEach(model.snapshot.environments) { environment in
                        Text(environment.name).tag(environment.id)
                    }
                }.disabled(draft != nil)
                Text("Custom prices apply to past and future usage on this environment. Prices are USD per million tokens.")
                    .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                if let errorMessage { SettingsErrorBanner(message: errorMessage) }
                if loading { ProgressView().frame(maxWidth: .infinity) }
                else if let prices {
                    ThreadDetailsSection(title: "Custom model prices", footer: "Blank cache rates use the input price. Enter 0 for free tokens. Model IDs are case-sensitive.") {
                        ForEach(prices.keys.sorted(), id: \.self) { name in
                            ThreadDetailsRow(systemImage: "dollarsign.circle", title: name,
                                subtitle: "Input $\(prices[name]!.inputCostPerMillionTokens.formatted()) · Output $\(prices[name]!.outputCostPerMillionTokens.formatted())",
                                action: { draft = PriceDraft(model: name, price: prices[name]) })
                        }
                        ThreadDetailsRow(systemImage: "plus", title: "Add model price", action: { draft = PriceDraft() })
                    }
                } else if !loading && errorMessage == nil {
                    Text("Connect an environment with model pricing support to edit prices.")
                        .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                }
            }.padding(18)
        }
        .background(T3Colors.background)
        .navigationTitle("Model prices")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { if environmentID.isEmpty { environmentID = model.snapshot.environments.first?.id ?? "" } }
        .task(id: environmentID) { await load() }
        .refreshable { await load() }
        .sheet(item: $draft, onDismiss: { Task { await load() } }) { initial in
            ModelPriceEditor(initial: initial, existingModels: Set(prices?.keys.map { $0 } ?? [])) { name, price in
                try await manager.updateServerSettings(environmentID: environmentID,
                    patch: ServerSettingsPatchInput(usagePriceOverrides: [name: price]))
                draft = nil
            }
        }
    }

    private func load() async {
        let requestedID = environmentID
        guard !requestedID.isEmpty else { return }
        prices = nil
        errorMessage = nil
        loading = true
        do {
            let config = try await manager.providerModelConfiguration(environmentID: requestedID)
            guard !Task.isCancelled, environmentID == requestedID else { return }
            prices = config.settings?.usagePriceOverrides
        } catch {
            guard !Task.isCancelled, environmentID == requestedID else { return }
            errorMessage = error.localizedDescription
        }
        loading = false
    }
}

struct PriceDraft: Identifiable {
    let id = UUID()
    var model: String
    let isNew: Bool
    var input: String
    var output: String
    var cacheRead: String
    var cacheWrite: String

    init(model: String = "", price: UsageModelPriceOverride? = nil) {
        self.model = model
        isNew = price == nil
        input = price.map { String($0.inputCostPerMillionTokens) } ?? ""
        output = price.map { String($0.outputCostPerMillionTokens) } ?? ""
        cacheRead = price?.cacheReadCostPerMillionTokens.map { String($0) } ?? ""
        cacheWrite = price?.cacheWriteCostPerMillionTokens.map { String($0) } ?? ""
    }

    var parsed: UsageModelPriceOverride? {
        func number(_ text: String) -> Double? {
            let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let value = Double(text), value.isFinite, value >= 0 else { return nil }
            return value
        }
        guard !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let input = number(input), let output = number(output) else { return nil }
        let read = cacheRead.trimmingCharacters(in: .whitespacesAndNewlines)
        let write = cacheWrite.trimmingCharacters(in: .whitespacesAndNewlines)
        guard read.isEmpty || number(read) != nil, write.isEmpty || number(write) != nil else { return nil }
        return UsageModelPriceOverride(inputCostPerMillionTokens: input, outputCostPerMillionTokens: output,
            cacheReadCostPerMillionTokens: number(read), cacheWriteCostPerMillionTokens: number(write))
    }
}

private struct ModelPriceEditor: View {
    @State var draft: PriceDraft
    let existingModels: Set<String>
    let save: (String, UsageModelPriceOverride?) async throws -> Void
    @State private var busy = false
    @State private var errorMessage: String?
    @SwiftUI.Environment(\.dismiss) private var dismiss

    init(initial: PriceDraft, existingModels: Set<String>, save: @escaping (String, UsageModelPriceOverride?) async throws -> Void) {
        _draft = State(initialValue: initial)
        self.existingModels = existingModels
        self.save = save
    }

    private var valid: Bool {
        draft.parsed != nil && (!draft.isNew || !existingModels.contains(draft.model.trimmingCharacters(in: .whitespacesAndNewlines)))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    field("Model ID", value: $draft.model, numeric: false).disabled(!draft.isNew || busy)
                    field("Input", value: $draft.input)
                    field("Output", value: $draft.output)
                    field("Cache read (optional)", value: $draft.cacheRead)
                    field("Cache write (optional)", value: $draft.cacheWrite)
                    Text("USD per million tokens. Blank cache rates use the input rate; 0 means free.")
                        .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                    if !valid { Text("Use a unique model ID and non-negative input and output prices.").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary) }
                    if let errorMessage { SettingsErrorBanner(message: errorMessage) }
                    SettingsActionButton(title: "Save price", systemImage: "checkmark", tone: .primary,
                        isBusy: busy, isDisabled: !valid, action: { perform(reset: false) })
                    if !draft.isNew {
                        Button("Reset to automatic pricing") { perform(reset: true) }.disabled(busy)
                    }
                }.padding(18)
            }
            .background(T3Colors.background)
            .navigationTitle(draft.isNew ? "Add model price" : "Edit model price")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) } }
            .t3NavigationChrome()
        }.interactiveDismissDisabled(busy)
    }

    private func field(_ title: String, value: Binding<String>, numeric: Bool = true) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
            TextField(title, text: value).textFieldStyle(.roundedBorder)
                .keyboardType(numeric ? .decimalPad : .default)
                .textInputAutocapitalization(.never).autocorrectionDisabled().disabled(busy)
        }
    }

    private func perform(reset: Bool) {
        guard !busy, reset || valid else { return }
        busy = true
        errorMessage = nil
        let name = draft.model.trimmingCharacters(in: .whitespacesAndNewlines)
        let price = reset ? nil : draft.parsed
        Task { @MainActor in
            do { try await save(name, price) }
            catch { errorMessage = error.localizedDescription }
            busy = false
        }
    }
}
