import SwiftUI

/// Per-model price overrides on one server, used to cost past and future usage.
/// Pushed from Usage.
struct SettingsModelPricesView: View {
    @Bindable var model: FeatureRootModel
    @State private var environmentID = ""
    /// `nil` while loading, and after a load from a server without pricing
    /// support; `loaded` tells those two apart.
    @State private var prices: [String: UsageModelPriceOverride]?
    @State private var loaded = false
    @State private var errorMessage: String?
    @State private var draft: PriceDraft?
    @State private var resetTarget: String?
    @State private var resetFailure: String?

    private var manager: any FeatureServerSettingsManaging {
        (model.client as? any FeatureServerSettingsManaging) ?? EmptyFeatureServerSettingsManager.shared
    }

    private var serverName: String {
        model.snapshot.environments.first { $0.id == environmentID }?.name ?? "this server"
    }

    var body: some View {
        content
            .settingsServerScope(
                title: "Model Prices",
                environments: model.snapshot.environments,
                selection: $environmentID,
                isEnabled: draft == nil
            )
            .toolbar {
                if prices != nil {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Add Price", systemImage: "plus") { draft = PriceDraft() }
                    }
                }
            }
            .onAppear {
                if environmentID.isEmpty {
                    environmentID = model.snapshot.environments.first(where: \.isActive)?.id
                        ?? model.snapshot.environments.first?.id ?? ""
                }
            }
            .task(id: environmentID) { await load() }
            .sheet(item: $draft) { initial in
                ModelPriceEditor(initial: initial, existingModels: Set(prices?.keys.map { $0 } ?? [])) { name, price in
                    try await write(name, price)
                }
            }
            .alert(
                "Couldn't Reset Price",
                isPresented: Binding(get: { resetFailure != nil }, set: { if !$0 { resetFailure = nil } })
            ) {
                Button("OK") { resetFailure = nil }
            } message: {
                Text(resetFailure ?? "")
            }
    }

    @ViewBuilder
    private var content: some View {
        if !loaded {
            SettingsForm { Section { SettingsPlaceholderRows(count: 3) } }
        } else if let errorMessage, prices == nil {
            SettingsForm {
                SettingsRetrySection(message: errorMessage) { Task { await load() } }
            }
        } else if let prices {
            if prices.isEmpty {
                ContentUnavailableView {
                    Label("No Custom Prices", systemImage: "dollarsign.circle")
                } description: {
                    Text("Usage on \(serverName) is priced automatically. Add a price to override one model.")
                } actions: {
                    Button("Add Price") { draft = PriceDraft() }
                        .t3ProminentButtonStyle()
                }
                .background(T3Colors.background)
            } else {
                list(prices)
            }
        } else {
            ContentUnavailableView(
                "Model Pricing Unavailable",
                systemImage: "dollarsign.circle",
                description: Text("Connect an environment with model pricing support to edit prices.")
            )
            .background(T3Colors.background)
        }
    }

    private func list(_ prices: [String: UsageModelPriceOverride]) -> some View {
        SettingsForm {
            Section {
                ForEach(prices.keys.sorted(), id: \.self) { name in
                    let price = prices[name]!
                    Button { draft = PriceDraft(model: name, price: price) } label: {
                        LabeledContent {
                            Text("\(Self.usd(price.inputCostPerMillionTokens)) · \(Self.usd(price.outputCostPerMillionTokens))")
                                .monospacedDigit()
                        } label: {
                            Text(name).foregroundStyle(T3Colors.textPrimary)
                        }
                    }
                    .swipeActions(edge: .trailing) {
                        Button("Reset", role: .destructive) { resetTarget = name }
                    }
                    .confirmationDialog(
                        "Use Automatic Pricing for \(name)?",
                        isPresented: Binding(
                            get: { resetTarget == name },
                            set: { if !$0 { resetTarget = nil } }
                        ),
                        titleVisibility: .visible
                    ) {
                        Button("Use Automatic Pricing", role: .destructive) { reset(name) }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("The custom price is removed and usage is priced automatically again.")
                    }
                }
            } footer: {
                Text("Input · output, USD per million tokens. Custom prices apply to past and future usage on \(serverName). Blank cache rates use the input price.")
            }
        }
        .refreshable { await load() }
    }

    static func usd(_ value: Double) -> String {
        value.formatted(.currency(code: "USD").precision(.fractionLength(2...4)))
    }

    private func load() async {
        let requestedID = environmentID
        guard !requestedID.isEmpty else { return }
        errorMessage = nil
        do {
            let config = try await manager.providerModelConfiguration(environmentID: requestedID)
            guard !Task.isCancelled, environmentID == requestedID else { return }
            prices = config.settings?.usagePriceOverrides
        } catch {
            guard !Task.isCancelled, environmentID == requestedID else { return }
            prices = nil
            errorMessage = error.localizedDescription
        }
        loaded = true
    }

    private func write(_ name: String, _ price: UsageModelPriceOverride?) async throws {
        try await manager.updateServerSettings(
            environmentID: environmentID,
            patch: ServerSettingsPatchInput(usagePriceOverrides: [name: price])
        )
        await load()
    }

    private func reset(_ name: String) {
        Task { @MainActor in
            do {
                try await write(name, nil)
            } catch {
                PlatformHapticEngine.shared.play(.error)
                resetFailure = error.localizedDescription
            }
        }
    }
}

/// The editable text of one model price. Held as text because it is typed;
/// parsed with the reader's locale, because the decimal pad types that
/// locale's separator — "1,25" in Germany — and a parser that only accepts
/// "." would reject every fractional price there.
struct PriceDraft: Identifiable {
    let id = UUID()
    var model: String
    let isNew: Bool
    var input: String
    var output: String
    var cacheRead: String
    var cacheWrite: String

    init(model: String = "", price: UsageModelPriceOverride? = nil, locale: Locale = .autoupdatingCurrent) {
        self.model = model
        isNew = price == nil
        input = price.map { Self.text($0.inputCostPerMillionTokens, locale: locale) } ?? ""
        output = price.map { Self.text($0.outputCostPerMillionTokens, locale: locale) } ?? ""
        cacheRead = price?.cacheReadCostPerMillionTokens.map { Self.text($0, locale: locale) } ?? ""
        cacheWrite = price?.cacheWriteCostPerMillionTokens.map { Self.text($0, locale: locale) } ?? ""
    }

    var parsed: UsageModelPriceOverride? { parsed(locale: .autoupdatingCurrent) }

    func parsed(locale: Locale) -> UsageModelPriceOverride? {
        guard !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let input = Self.number(input, locale: locale),
              let output = Self.number(output, locale: locale) else { return nil }
        let read = cacheRead.trimmingCharacters(in: .whitespacesAndNewlines)
        let write = cacheWrite.trimmingCharacters(in: .whitespacesAndNewlines)
        let readValue = Self.number(read, locale: locale)
        let writeValue = Self.number(write, locale: locale)
        guard read.isEmpty || readValue != nil, write.isEmpty || writeValue != nil else { return nil }
        return UsageModelPriceOverride(
            inputCostPerMillionTokens: input,
            outputCostPerMillionTokens: output,
            cacheReadCostPerMillionTokens: readValue,
            cacheWriteCostPerMillionTokens: writeValue
        )
    }

    /// Whether `text` is empty or a valid price, for the per-field hint.
    static func isAcceptable(_ text: String, locale: Locale = .autoupdatingCurrent) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || number(trimmed, locale: locale) != nil
    }

    /// A non-negative, finite price typed in `locale`'s notation: digits with
    /// at most one decimal mark, the locale's or a plain "." (a hardware
    /// keyboard, or a value pasted into a comma locale). Grouping is never
    /// read, so "1.234" cannot silently become 1234, and the whole string must
    /// parse, so "1,2.3" is rejected rather than truncated.
    static func number(_ text: String, locale: Locale) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let value: Double?
        if trimmed.allSatisfy(\.isASCII) {
            let separator = locale.decimalSeparator ?? "."
            let normalized = separator == "." ? trimmed : trimmed.replacingOccurrences(of: separator, with: ".")
            let isPlainDecimal = normalized.allSatisfy { $0.isNumber || $0 == "." }
                && normalized.filter { $0 == "." }.count <= 1
                && normalized.contains(where: \.isNumber)
            value = isPlainDecimal ? Double(normalized) : nil
        } else {
            // Digits of another numbering system, as a decimal pad in some
            // locales types them.
            let formatter = NumberFormatter()
            formatter.locale = locale
            formatter.numberStyle = .decimal
            formatter.usesGroupingSeparator = false
            formatter.isLenient = false
            value = formatter.number(from: trimmed)?.doubleValue
        }
        guard let value, value.isFinite, value >= 0 else { return nil }
        return value
    }

    /// A stored price as the reader would type it: "3" rather than "3.0", and
    /// "1,25" in a comma locale.
    static func text(_ value: Double, locale: Locale) -> String {
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = false
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = 10
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }
}

/// Add or edit one price. A sheet with cancel and confirm in its toolbar; the
/// draft survives a failed save.
private struct ModelPriceEditor: View {
    private enum Field: Hashable { case model, input, output, cacheRead, cacheWrite }

    @State private var draft: PriceDraft
    private let initial: PriceDraft
    let existingModels: Set<String>
    let save: (String, UsageModelPriceOverride?) async throws -> Void
    @State private var busy = false
    @State private var failure: String?
    @State private var confirmingReset = false
    @SwiftUI.Environment(\.dismiss) private var dismiss

    init(
        initial: PriceDraft,
        existingModels: Set<String>,
        save: @escaping (String, UsageModelPriceOverride?) async throws -> Void
    ) {
        _draft = State(initialValue: initial)
        self.initial = initial
        self.existingModels = existingModels
        self.save = save
    }

    private var trimmedModel: String { draft.model.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var isDuplicate: Bool { draft.isNew && existingModels.contains(trimmedModel) }
    private var valid: Bool { draft.parsed != nil && !isDuplicate }

    private var hasChanges: Bool {
        draft.model != initial.model || draft.input != initial.input || draft.output != initial.output
            || draft.cacheRead != initial.cacheRead || draft.cacheWrite != initial.cacheWrite
    }

    private var invalidFields: [String] {
        [("Input", draft.input), ("Output", draft.output), ("Cache Read", draft.cacheRead), ("Cache Write", draft.cacheWrite)]
            .filter { !PriceDraft.isAcceptable($0.1) }
            .map(\.0)
    }

    var body: some View {
        NavigationStack {
            SettingsForm {
                if draft.isNew {
                    Section {
                        TextField("Model ID", text: $draft.model)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    } footer: {
                        if isDuplicate {
                            Text("A price for this model already exists.").foregroundStyle(T3Colors.danger)
                        } else {
                            Text("Model IDs are case-sensitive.")
                        }
                    }
                }

                Section {
                    priceField("Input", text: $draft.input, placeholder: "Required")
                    priceField("Output", text: $draft.output, placeholder: "Required")
                    priceField("Cache Read", text: $draft.cacheRead, placeholder: "Same as Input")
                    priceField("Cache Write", text: $draft.cacheWrite, placeholder: "Same as Input")
                } header: {
                    Text("Per Million Tokens, USD")
                } footer: {
                    if !invalidFields.isEmpty {
                        Text("\(invalidFields.joined(separator: ", ")): enter a price of 0 or more.")
                            .foregroundStyle(T3Colors.danger)
                    } else {
                        Text("Enter 0 for free tokens.")
                    }
                }

                if !draft.isNew {
                    Section {
                        Button("Reset to Automatic Pricing", role: .destructive) { confirmingReset = true }
                            .foregroundStyle(T3Colors.danger)
                            .confirmationDialog(
                                "Use Automatic Pricing for \(trimmedModel)?",
                                isPresented: $confirmingReset,
                                titleVisibility: .visible
                            ) {
                                Button("Use Automatic Pricing", role: .destructive) { perform(reset: true) }
                                Button("Cancel", role: .cancel) {}
                            } message: {
                                Text("The custom price is removed and usage is priced automatically again.")
                            }
                    }
                }
            }
            .disabled(busy)
            .navigationTitle(draft.isNew ? "Add Price" : trimmedModel)
            .navigationBarTitleDisplayMode(.inline)
            .t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(
                    title: "Save",
                    isEnabled: valid && (draft.isNew || hasChanges),
                    isBusy: busy,
                    action: { perform(reset: false) }
                ),
                hasChanges: hasChanges || busy
            )
            .alert(
                "Couldn't Save Price",
                isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
            ) {
                Button("OK") { failure = nil }
            } message: {
                Text(failure ?? "")
            }
        }
    }

    private func priceField(_ title: String, text: Binding<String>, placeholder: String) -> some View {
        HStack {
            Text(title)
            Spacer(minLength: 12)
            TextField(placeholder, text: text)
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.trailing)
                .foregroundStyle(PriceDraft.isAcceptable(text.wrappedValue) ? T3Colors.textPrimary : T3Colors.danger)
                .accessibilityLabel("\(title), US dollars per million tokens")
        }
    }

    private func perform(reset: Bool) {
        guard !busy, reset || valid else { return }
        busy = true
        let name = trimmedModel
        let price = reset ? nil : draft.parsed
        Task { @MainActor in
            do {
                try await save(name, price)
                PlatformHapticEngine.shared.play(.success)
                busy = false
                dismiss()
            } catch {
                busy = false
                PlatformHapticEngine.shared.play(.error)
                failure = error.localizedDescription
            }
        }
    }
}
