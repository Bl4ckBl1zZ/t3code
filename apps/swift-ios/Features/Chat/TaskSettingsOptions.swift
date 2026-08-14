import Foundation

/// One knob in the composer's task-settings sheet.
///
/// Swift counterpart of `thread-settings-options.ts` in `apps/mobile`: the
/// sheet renders whatever the active model publishes rather than a hardcoded
/// list, so a provider that ships a new option gets a row without an app
/// release.
public struct TaskSettingsRow: Identifiable, Equatable, Sendable {
    public let descriptor: FeatureModelOptionDescriptor
    /// The value shown on the row itself, so the sheet reads as a summary
    /// before anything is opened.
    public let valueLabel: String
    /// Set for `.select` descriptors; the choice the picker should check.
    public let selectedChoiceID: String?
    /// Set for `.boolean` descriptors.
    public let isEnabled: Bool

    public var id: String { descriptor.id }

    public init(
        descriptor: FeatureModelOptionDescriptor,
        valueLabel: String,
        selectedChoiceID: String?,
        isEnabled: Bool
    ) {
        self.descriptor = descriptor
        self.valueLabel = valueLabel
        self.selectedChoiceID = selectedChoiceID
        self.isEnabled = isEnabled
    }
}

public enum TaskSettingsOptions {
    /// Rows for every option the model publishes, in catalog order.
    ///
    /// A `.select` with no choices is dropped: it would push a picker with
    /// nothing in it. Booleans always survive — they need no choices.
    public static func rows(
        for model: FeatureModel?,
        selections: [FeatureModelOptionSelection]
    ) -> [TaskSettingsRow] {
        guard let model else { return [] }
        return model.options.compactMap { descriptor in
            switch descriptor.kind {
            case .select:
                guard !descriptor.choices.isEmpty else { return nil }
                let choiceID = selectedChoiceID(of: descriptor, in: selections)
                let choice = descriptor.choices.first { $0.id == choiceID }
                return TaskSettingsRow(
                    descriptor: descriptor,
                    valueLabel: choice?.label ?? choiceID,
                    selectedChoiceID: choiceID,
                    isEnabled: false
                )
            case .boolean:
                let isEnabled = isEnabled(descriptor, in: selections)
                return TaskSettingsRow(
                    descriptor: descriptor,
                    valueLabel: isEnabled ? "On" : "Off",
                    selectedChoiceID: nil,
                    isEnabled: isEnabled
                )
            }
        }
    }

    /// The label on the composer's settings trigger: the model, then whatever
    /// its options currently resolve to. Falls back to a call to action rather
    /// than an empty pill, which would read as a broken control.
    public static func summary(
        modelName: String?,
        model: FeatureModel?,
        selections: [FeatureModelOptionSelection]
    ) -> String {
        guard let modelName, !modelName.isEmpty else { return "Choose model" }
        guard let model,
              let options = DailyUXModelOptions.summary(for: model, selections: selections) else {
            return modelName
        }
        return "\(modelName) · \(options)"
    }

    public static func selectedChoiceID(
        of descriptor: FeatureModelOptionDescriptor,
        in selections: [FeatureModelOptionSelection]
    ) -> String {
        if case let .string(value)? = DailyUXModelOptions.value(for: descriptor, in: selections) {
            return value
        }
        return descriptor.choices.first(where: \.isDefault)?.id
            ?? descriptor.choices.first?.id
            ?? ""
    }

    public static func isEnabled(
        _ descriptor: FeatureModelOptionDescriptor,
        in selections: [FeatureModelOptionSelection]
    ) -> Bool {
        if case let .boolean(value)? = DailyUXModelOptions.value(for: descriptor, in: selections) {
            return value
        }
        return false
    }
}
